import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnChaosChild } from "./process-harness.ts";
import { createChaosWorld, type ChaosWorld } from "./world.ts";

describe("chaos process harness", () => {
  let world: ChaosWorld;

  beforeAll(async () => {
    world = await createChaosWorld();
  });

  afterAll(async () => {
    await world.database.close();
  });

  it("rejects a wait for a checkpoint that an idle engine child never reaches", async () => {
    const child = spawnChaosChild({
      schema: world.database.schema,
      queueName: "idle-queue",
      crashPoint: "before-record",
      runtime: "engine",
    });
    try {
      await child.waitForLine("ready");
      await expect(child.waitForLine("checkpoint before-record", 300)).rejects.toThrow(
        'did not print "checkpoint before-record" within 300 ms',
      );
    } finally {
      await child.kill("SIGKILL");
    }
  });

  it("resolves with the line when it appears before the deadline", async () => {
    const child = spawnChaosChild({
      schema: world.database.schema,
      queueName: "ready-queue",
      runtime: "engine",
    });
    try {
      await expect(child.waitForLine("ready", 20_000)).resolves.toMatch(/^ready /);
    } finally {
      await child.kill("SIGKILL");
    }
  });

  it("rejects when the child exits before printing the line, with or without a deadline", async () => {
    const child = spawnChaosChild({
      schema: world.database.schema,
      queueName: "exit-queue",
      runtime: "engine",
    });
    await child.waitForLine("ready");
    const waiting = child.waitForLine("never printed", 20_000);
    await child.kill("SIGKILL");
    await expect(waiting).rejects.toThrow("child exited before printing");
  });
});
