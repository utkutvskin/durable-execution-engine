import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTaskQueue,
  ENGINE_METRIC_NAMES,
  loadMigrations,
  defaultMigrationsDir,
} from "@dee/core";
import { parsePrometheusText } from "../../core/src/observability/prometheus-text.ts";
import { createIsolatedSchema, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import type { CliIo } from "./io.ts";
import { main } from "./main.ts";
import { urlForSchema } from "./test-support.ts";

const WF = fileURLToPath(new URL("../bin/wf.js", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const KEY = "dee_process-test-key-000001";

interface Spawned {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[];
  readonly exited: Promise<number>;
}

function spawnWf(args: string[], env: Record<string, string>): Spawned {
  const child = spawn(process.execPath, [WF, ...args], {
    cwd: REPO,
    env: { ...process.env, NODE_ENV: "production", ...env },
  });
  const lines: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => lines.push(line));
  createInterface({ input: child.stderr }).on("line", (line) => lines.push(`stderr: ${line}`));
  const exited = new Promise<number>((resolve) => {
    child.on("close", (code) => {
      resolve(code ?? -1);
    });
  });
  return { child, lines, exited };
}

async function logged(process: Spawned, message: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    for (const line of process.lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry["message"] === message) {
          return entry;
        }
      } catch {
        continue;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`"${message}" was not logged; output: ${process.lines.join(" | ")}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

async function terminate(process: Spawned): Promise<number> {
  process.child.kill("SIGTERM");
  return process.exited;
}

function io(env: Record<string, string>, out: string[]): CliIo {
  return { stdout: (line) => out.push(line), stderr: (line) => out.push(line), env, cwd: REPO };
}

async function scrape(url: string): Promise<ReturnType<typeof parsePrometheusText>> {
  return parsePrometheusText(await (await fetch(url)).text());
}

describe("separate wf processes", () => {
  let schema: IsolatedSchema;
  let env: Record<string, string>;

  beforeAll(async () => {
    schema = await createIsolatedSchema();
    env = { DATABASE_URL: urlForSchema(schema.schema) };
  });

  afterAll(async () => {
    await schema.close();
  });

  it("lets two wf migrate up processes started together both succeed and apply each migration once", async () => {
    const first = spawnWf(["migrate", "up"], env);
    const second = spawnWf(["migrate", "up"], env);
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
    const expected = (await loadMigrations(defaultMigrationsDir)).map((entry) => entry.id);
    const applied = [...first.lines, ...second.lines]
      .filter((line) => line.startsWith("applied "))
      .map((line) => line.slice("applied ".length))
      .sort();
    expect(applied).toEqual(expected);
    const rows = await schema.pool.query("select 1 from schema_migrations");
    expect(rows.rowCount).toBe(expected.length);
  }, 60_000);

  it("completes the payment saga through wf serve and two wf worker processes with every metric present", async () => {
    const serve = spawnWf(["serve", "--port", "0", "--host", "127.0.0.1"], {
      ...env,
      WF_API_KEY: KEY,
      WF_METRICS_CACHE_MS: "0",
    });
    const workers = [1, 2].map(() =>
      spawnWf(
        [
          "worker",
          "--example",
          "payment-saga",
          "--health-port",
          "0",
          "--health-host",
          "127.0.0.1",
          "--concurrency",
          "2",
        ],
        env,
      ),
    );
    try {
      const api = (await logged(serve, "api listening"))["url"] as string;
      const opsUrls = await Promise.all(
        workers.map(
          async (worker) =>
            `http://127.0.0.1:${String((await logged(worker, "worker running"))["opsPort"])}`,
        ),
      );
      const out: string[] = [];
      const clientEnv = { WF_API_URL: api, WF_API_KEY: KEY };
      const customers = ["c1", "c2", "customer-flaky", "c4", "c5", "c6"];
      for (const [index, customerId] of customers.entries()) {
        const code = await main(
          [
            "run",
            "start",
            "payment-saga",
            "--input",
            JSON.stringify({ orderId: `proc-${String(index)}`, customerId, amountCents: 1200 }),
            "--wait",
            "--json",
          ],
          io(clientEnv, out),
        );
        expect(code, out.join("\n")).toBe(0);
      }
      const finished = out.map((line) => JSON.parse(line) as { status: string });
      expect(finished.map((run) => run.status)).toEqual(customers.map(() => "COMPLETED"));

      const queue = createTaskQueue(schema.pool);
      const runs = await schema.pool.query<{ id: string; namespace_id: string }>(
        "select id, namespace_id from workflow_runs limit 1",
      );
      await queue.enqueue({
        namespaceId: runs.rows[0]?.namespace_id ?? "",
        runId: runs.rows[0]?.id ?? "",
        queueName: "orphans",
        taskType: "WORKFLOW_TASK",
      });
      await queue.dequeue({ queueName: "orphans", visibilityTimeoutMs: 1, workerId: "crashed" });

      const sources = [api, ...opsUrls];
      const deadline = Date.now() + 20_000;
      let missing: string[] = [...ENGINE_METRIC_NAMES];
      let reclaimed = 0;
      while (Date.now() < deadline) {
        const samples = (
          await Promise.all(sources.map((source) => scrape(`${source}/metrics`)))
        ).flatMap((parsed) => parsed.samples);
        missing = ENGINE_METRIC_NAMES.filter(
          (name) =>
            !samples.some((sample) => sample.name === name || sample.name === `${name}_count`),
        );
        reclaimed = samples
          .filter((sample) => sample.name === "dee_leases_reclaimed_total")
          .reduce((sum, sample) => sum + sample.value, 0);
        const retries = samples.find((sample) => sample.name === "dee_step_retries_total");
        if (missing.length === 0 && reclaimed >= 1 && (retries?.value ?? 0) >= 1) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      expect(missing).toEqual([]);
      expect(reclaimed).toBeGreaterThanOrEqual(1);

      const latency = (await Promise.all(opsUrls.map((source) => scrape(`${source}/metrics`))))
        .flatMap((parsed) => parsed.samples)
        .filter((sample) => sample.name === "dee_task_latency_seconds_count")
        .reduce((sum, sample) => sum + sample.value, 0);
      expect(latency).toBeGreaterThan(0);
    } finally {
      const codes = await Promise.all([serve, ...workers].map((spawned) => terminate(spawned)));
      expect(codes).toEqual([0, 0, 0]);
    }
  }, 120_000);
});
