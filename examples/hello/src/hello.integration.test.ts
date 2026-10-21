import { afterEach, describe, expect, it } from "vitest";
import { createShiftableClock } from "../../../packages/worker/src/chaos/world.js";
import {
  startTestEnvironment,
  type TestEnvironment,
} from "../../../packages/cli/src/test-support.js";
import { steps, workflows, type HelloResult } from "./index.js";

describe("hello", () => {
  let current: TestEnvironment | undefined;

  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it("exports one workflow and one step", () => {
    expect(workflows.map((workflow) => workflow.workflowType)).toEqual(["hello"]);
    expect(steps.map((step) => step.stepType)).toEqual(["hello.build-greeting"]);
  });

  it("stays suspended on its timer until the clock passes one second", async () => {
    const clock = createShiftableClock();
    current = await startTestEnvironment({ workflows, steps }, { clock });
    const { client } = current.environment;
    const runId = await client.start("hello", { name: "ada" });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect((await client.describe(runId)).status).toBe("RUNNING");
    clock.shift(1_001);
    const run = await client.waitForClose(runId);
    expect(run.status).toBe("COMPLETED");
    expect(run.result).toEqual({ greeting: "hello, ada" } satisfies HelloResult);
  });

  it("returns the first run for a repeated idempotency key", async () => {
    const clock = createShiftableClock();
    current = await startTestEnvironment({ workflows, steps }, { clock });
    const { client } = current.environment;
    const first = await client.start("hello", { name: "grace" }, "k-1");
    const second = await client.start("hello", { name: "grace" }, "k-1");
    expect(second).toBe(first);
    expect((await client.listRuns({ workflowType: "hello" })).runs).toHaveLength(1);
  });
});
