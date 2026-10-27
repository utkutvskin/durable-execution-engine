import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  commandToEvent,
  ConcurrencyError,
  createAttemptLog,
  createDeadLetterQueue,
  createPool,
  createPostgresEventStore,
  createResultRecorder,
  createStepTaskProcessor,
  createTaskQueue,
  defineStep,
  defineWorkflow,
  runDecisionLoop,
  silentLogger,
  systemClock,
  systemRandomSource,
  type EventStore,
  type Pool,
  type StepDefinition,
  type TaskQueue,
} from "@dee/core";
import { createApiServer, type ApiHandler } from "../../packages/api/src/index.js";
import {
  createIsolatedDatabase,
  type IsolatedSchema,
} from "../../packages/core/src/db/test-harness.js";
import { planBrowser } from "./browser.js";
import { createUiHandler } from "../../apps/ui/src/server.js";

const STEP_QUEUE = "default/steps";
const BROWSER = planBrowser({ env: process.env });

if (BROWSER.mode === "skip") {
  console.warn(`explorer e2e skipped: ${BROWSER.message}`);
}

const approval = defineWorkflow("approval", async (ctx, input: { item: string }) => {
  const reserved = await ctx.step<string>("reserve", input);
  const decision = await ctx.waitForSignal<{ approved: boolean }>("decision");
  return decision.approved
    ? ctx.step<string>("ship", { reserved })
    : ctx.step<string>("release", { reserved });
});

describe.skipIf(BROWSER.mode === "skip")("run explorer in a browser", () => {
  let database: IsolatedSchema;
  let api: ApiHandler & { server: import("node:http").Server };
  let baseUrl: string;
  let serverPool: Pool;
  let browser: Browser;
  let page: Page;
  let store: EventStore;
  let queue: TaskQueue;
  let key: string;
  let namespaceId: string;
  let taskCounter = 0;

  async function startRun(
    workflowType = "approval",
    input: unknown = { item: "book" },
    apiKey = key,
  ): Promise<string> {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ workflowType, input }),
    });
    return ((await response.json()) as { run: { runId: string } }).run.runId;
  }

  async function eventCount(): Promise<number> {
    const result = await database.pool.query<{ count: string }>("select count(*) from run_events");
    return Number(result.rows[0]?.count);
  }

  async function pump(): Promise<void> {
    const sources = { clock: systemClock, random: systemRandomSource };
    for (let round = 0; round < 20; round += 1) {
      const before = await eventCount();
      for (;;) {
        const [task] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
        if (task === undefined) {
          break;
        }
        await queue.ack(task.id, task.leaseToken);
      }
      for (;;) {
        const [task] = await queue.dequeue({ queueName: STEP_QUEUE, visibilityTimeoutMs: 30_000 });
        if (task === undefined) {
          break;
        }
        await processor.process(task);
      }
      const open = await database.pool.query<{ id: string; input: unknown }>(
        "select id, input from workflow_runs where status = 'RUNNING' and workflow_type = 'approval'",
      );
      for (const run of open.rows) {
        const events = (await store.read(run.id)).map((stored) => stored.event);
        const decision = await runDecisionLoop(
          approval.handler,
          run.input as never,
          events,
          sources,
        );
        taskCounter += 1;
        try {
          await recorder.recordWorkflowTaskResult({
            runId: run.id,
            taskKey: `e2e-${String(taskCounter)}`,
            expectedSeq: events.length,
            events: decision.commands.map(commandToEvent),
          });
        } catch (error) {
          if (error instanceof ConcurrencyError) {
            continue;
          }
          throw error;
        }
        for (const command of decision.commands) {
          if (command.type === "schedule_step") {
            await queue.enqueue({
              namespaceId,
              runId: run.id,
              queueName: STEP_QUEUE,
              taskType: "STEP_TASK",
              payload: { stepId: command.stepId, stepType: command.stepType, input: command.input },
            });
          }
        }
      }
      if ((await eventCount()) === before) {
        return;
      }
    }
  }

  let recorder: ReturnType<typeof createResultRecorder>;
  let processor: ReturnType<typeof createStepTaskProcessor>;

  async function signIn(apiKey = key): Promise<void> {
    await page.goto(`${baseUrl}/ui/`);
    await page.getByTestId("api-key-input").fill(apiKey);
    await page.getByTestId("sign-in").click();
    await page.getByTestId("namespace-name").waitFor();
  }

  async function openRun(runId: string): Promise<void> {
    await page.goto(`${baseUrl}/ui/#/runs/${runId}`);
    await page.getByTestId("run-status").waitFor();
  }

  function timelineItem(type: string): ReturnType<Page["locator"]> {
    return page.locator(`[data-testid=timeline-item][data-type=${type}]`);
  }

  beforeAll(async () => {
    if (BROWSER.mode === "fail") {
      throw new Error(BROWSER.message);
    }
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    queue = createTaskQueue(database.pool);
    recorder = createResultRecorder(database.pool, undefined, { queueName: "default" });
    const steps = new Map<string, StepDefinition>(
      ["reserve", "ship", "release"].map((name) => [
        name,
        defineStep(name, {
          handler: () =>
            name === "reserve" ? "reservation-1" : `${name}ped`.replace("releaseped", "released"),
        }),
      ]),
    );
    processor = createStepTaskProcessor({
      pool: database.pool,
      queue,
      recorder,
      attempts: createAttemptLog(database.pool),
      deadLetters: createDeadLetterQueue(database.pool),
      lookup: (stepType) => steps.get(stepType),
      clock: systemClock,
    });
    serverPool = createPool(process.env, { schema: database.schema, idleTimeoutMillis: 0 });
    api = createApiServer(serverPool, {
      queueName: "default",
      streamPollMs: 20,
      sideHandler: createUiHandler(),
      logger: silentLogger,
    });
    await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${String((api.server.address() as AddressInfo).port)}`;
    const issued = await api.apiKeys.issue("shop");
    key = issued.key;
    namespaceId = issued.namespaceId;
    browser = await chromium.launch({ executablePath: BROWSER.path, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser.close();
    api.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      api.server.close(() => {
        resolve();
      });
    });
    await serverPool.end();
    await database.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(10_000);
  });

  afterEach(async () => {
    await page.close();
  });

  it("shows a running workflow advancing without a page refresh", async () => {
    const runId = await startRun();
    await signIn();
    await openRun(runId);
    await expect.poll(() => timelineItem("run_started").count()).toBe(1);
    expect(await timelineItem("step_completed").count()).toBe(0);
    await page.evaluate("globalThis.survivesWithoutReload = true");
    await pump();
    await timelineItem("step_completed").first().waitFor();
    await expect.poll(() => page.getByTestId("run-status").textContent()).toBe("RUNNING");
    await expect.poll(() => page.getByTestId("live-indicator").textContent()).toBe("live");
    expect(await page.evaluate("globalThis.survivesWithoutReload")).toBe(true);
  }, 30_000);

  it("branches on a signal sent from the ui and shows the result", async () => {
    const runId = await startRun("approval", { item: "lamp" });
    await signIn();
    await openRun(runId);
    await pump();
    await timelineItem("step_completed").first().waitFor();
    await page.getByTestId("signal-name").fill("decision");
    await page.getByTestId("signal-payload").fill('{"approved": true}');
    await page.getByTestId("signal-send").click();
    await timelineItem("signal_received").first().waitFor();
    await pump();
    await page.locator("[data-testid=run-status]", { hasText: "COMPLETED" }).waitFor();
    expect(await page.getByTestId("output-viewer").textContent()).toBe('"shipped"');
    const scheduled = await timelineItem("step_scheduled").allTextContents();
    expect(scheduled.some((text) => text.includes("ship"))).toBe(true);
    expect(scheduled.some((text) => text.includes("release"))).toBe(false);
  }, 30_000);

  it("takes the other branch when the signal says no", async () => {
    const runId = await startRun("approval", { item: "vase" });
    await signIn();
    await openRun(runId);
    await pump();
    await timelineItem("step_completed").first().waitFor();
    await page.getByTestId("signal-name").fill("decision");
    await page.getByTestId("signal-payload").fill('{"approved": false}');
    await page.getByTestId("signal-send").click();
    await pump();
    await page.locator("[data-testid=run-status]", { hasText: "COMPLETED" }).waitFor();
    expect(await page.getByTestId("output-viewer").textContent()).toBe('"released"');
  }, 30_000);

  it("cancels a run from the ui", async () => {
    const runId = await startRun("approval", { item: "chair" });
    await signIn();
    await openRun(runId);
    await pump();
    await timelineItem("step_completed").first().waitFor();
    await page.getByTestId("cancel-button").click();
    await timelineItem("cancel_requested").first().waitFor();
    await pump();
    await page.locator("[data-testid=run-status]", { hasText: "CANCELLED" }).waitFor();
    await expect.poll(() => page.getByTestId("cancel-button").isDisabled()).toBe(true);
    await expect.poll(() => page.getByTestId("signal-send").isDisabled()).toBe(true);
    await expect.poll(() => page.getByTestId("live-indicator").textContent()).toBe("closed");
  }, 30_000);

  it("shows the input, the error and escapes markup in run data", async () => {
    const runId = await startRun("unregistered", { note: "<img src=x onerror=window.pwned=1>" });
    await signIn();
    await openRun(runId);
    expect(await page.getByTestId("input-viewer").textContent()).toContain(
      "<img src=x onerror=window.pwned=1>",
    );
    await expect.poll(() => page.locator("img").count()).toBe(0);
    expect(await page.getByTestId("error-viewer").textContent()).toBe("null");
    await database.pool.query(
      "update workflow_runs set status = 'FAILED', error = $2::jsonb, closed_at = now() where id = $1",
      [runId, JSON.stringify({ name: "ChargeError", message: "card declined" })],
    );
    await store.append(runId, 1, [
      { type: "run_failed", error: { name: "ChargeError", message: "card declined" } },
    ]);
    await page.locator("[data-testid=run-status]", { hasText: "FAILED" }).waitFor();
    expect(await page.getByTestId("error-viewer").textContent()).toContain("card declined");
  }, 30_000);

  it("filters the run list by status and workflow type and pages with load more", async () => {
    const other = await api.apiKeys.issue("paging");
    for (let index = 0; index < 27; index += 1) {
      await startRun("paged", { index }, other.key);
    }
    const odd = await startRun("odd-one", {}, other.key);
    await database.pool.query("update workflow_runs set status = 'COMPLETED' where id = $1", [odd]);
    await signIn(other.key);
    await page.locator("[data-testid=run-count]", { hasText: "25 runs" }).waitFor();
    await page.getByTestId("load-more").click();
    await page.locator("[data-testid=run-count]", { hasText: "28 runs" }).waitFor();
    expect(await page.getByTestId("load-more").isHidden()).toBe(true);
    expect(await page.getByTestId("namespace-name").textContent()).toBe("paging");

    await page.getByTestId("filter-type").fill("odd-one");
    await page.getByTestId("apply-filters").click();
    await page.locator("[data-testid=run-count]", { hasText: "1 runs" }).waitFor();
    expect(await page.getByTestId("run-row").getAttribute("data-run-id")).toBe(odd);

    await page.getByTestId("filter-type").fill("");
    await page.getByTestId("filter-status").selectOption("RUNNING");
    await page.getByTestId("apply-filters").click();
    await page.locator("[data-testid=run-count]", { hasText: "25 runs" }).waitFor();

    await page.getByTestId("filter-status").selectOption("");
    await page.getByTestId("filter-from").fill("2999-01-01");
    await page.getByTestId("apply-filters").click();
    await page.locator("[data-testid=run-count]", { hasText: "0 runs" }).waitFor();
  }, 60_000);

  it("requeues a dead letter from the ui", async () => {
    const runId = await startRun();
    const id = await createDeadLetterQueue(database.pool).add({
      namespaceId,
      runId,
      stepId: "step-1",
      queueName: STEP_QUEUE,
      payload: { stepId: "step-1", stepType: "reserve", input: {} },
      attempts: 3,
      error: { name: "ChargeError", message: "card declined" },
      reason: "MAX_ATTEMPTS_EXHAUSTED",
    });
    await signIn();
    await page.getByTestId("nav-dead-letters").click();
    const row = page.locator(`[data-dead-letter-id="${id}"]`);
    await row.waitFor();
    expect(await row.textContent()).toContain("card declined");
    await row.getByTestId("requeue-button").click();
    await page.locator("[data-testid=dead-letter-message]", { hasText: "requeued" }).waitFor();
    await row.waitFor({ state: "detached" });
    const task = await database.pool.query(
      "select 1 from tasks where run_id = $1 and task_type = 'STEP_TASK' and queue_name = $2",
      [runId, STEP_QUEUE],
    );
    expect(task.rowCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("rejects a wrong api key on the sign in form", async () => {
    await page.goto(`${baseUrl}/ui/`);
    await page.getByTestId("api-key-input").fill("dee_wrong");
    await page.getByTestId("sign-in").click();
    await page.getByTestId("sign-in-error").waitFor();
    expect(await page.getByTestId("namespace-name").count()).toBe(0);
  }, 30_000);
});
