import { z } from "zod";
import { describe, expect, it } from "vitest";
import { defineStep } from "./define-step.ts";
import { createStepRegistry, detachedStepContext } from "./step-registry.ts";

describe("defineStep", () => {
  it("runs the handler unchanged when no schema is given", async () => {
    const definition = defineStep<{ amount: number }, { charged: boolean }>("charge-card", {
      handler: (input) => ({ charged: input.amount > 0 }),
    });

    await expect(definition.handler({ amount: 42 })).resolves.toEqual({ charged: true });
  });

  it("validates the input against the input schema before the handler runs", async () => {
    const definition = defineStep("charge-card", {
      input: z.object({ amount: z.number().positive() }),
      handler: (input: { amount: number }) => ({ charged: input.amount > 0 }),
    });

    await expect(definition.handler({ amount: -1 })).rejects.toThrow();
  });

  it("validates the handler's result against the output schema", async () => {
    const definition = defineStep("charge-card", {
      output: z.object({ charged: z.boolean() }),
      handler: (): { charged: unknown } => ({ charged: "yes" }),
    });

    await expect(definition.handler(undefined)).rejects.toThrow();
  });

  it("passes a value through unchanged when it matches the output schema", async () => {
    const definition = defineStep("charge-card", {
      output: z.object({ charged: z.boolean() }),
      handler: (): { charged: boolean } => ({ charged: true }),
    });

    await expect(definition.handler(undefined)).resolves.toEqual({ charged: true });
  });

  it("carries the stepType and timeoutMs through onto the definition", () => {
    const definition = defineStep("charge-card", {
      handler: () => ({ charged: true }),
      timeoutMs: 5_000,
    });

    expect(definition.stepType).toBe("charge-card");
    expect(definition.timeoutMs).toBe(5_000);
  });

  it("rejects a zero timeoutMs", () => {
    expect(() => {
      defineStep("charge-card", { handler: () => ({ charged: true }), timeoutMs: 0 });
    }).toThrow('step "charge-card" has a non-positive timeoutMs (0)');
  });

  it("rejects a negative timeoutMs", () => {
    expect(() => {
      defineStep("charge-card", { handler: () => ({ charged: true }), timeoutMs: -1 });
    }).toThrow('step "charge-card" has a non-positive timeoutMs (-1)');
  });

  it("carries the schedule-to-close and heartbeat timeouts and reads startToCloseTimeoutMs as timeoutMs", () => {
    const definition = defineStep("import", {
      handler: () => "ok",
      startToCloseTimeoutMs: 30_000,
      scheduleToCloseTimeoutMs: 120_000,
      heartbeatTimeoutMs: 5_000,
    });

    expect(definition).toMatchObject({
      timeoutMs: 30_000,
      scheduleToCloseTimeoutMs: 120_000,
      heartbeatTimeoutMs: 5_000,
    });
  });

  it("rejects both timeoutMs and startToCloseTimeoutMs, and a non-positive heartbeat timeout", () => {
    expect(() => {
      defineStep("import", { handler: () => "ok", timeoutMs: 1, startToCloseTimeoutMs: 1 });
    }).toThrow(/both timeoutMs and startToCloseTimeoutMs/);
    expect(() => {
      defineStep("import", { handler: () => "ok", heartbeatTimeoutMs: 0 });
    }).toThrow('step "import" has a non-positive heartbeatTimeoutMs (0)');
    expect(() => {
      defineStep("import", { handler: () => "ok", scheduleToCloseTimeoutMs: -5 });
    }).toThrow('step "import" has a non-positive scheduleToCloseTimeoutMs (-5)');
  });

  it("registers its handler with a StepRegistry like any other step handler", async () => {
    const registry = createStepRegistry();
    const definition = defineStep<{ amount: number }, { charged: boolean }>("charge-card", {
      input: z.object({ amount: z.number().positive() }),
      handler: (input) => ({ charged: input.amount > 0 }),
    });

    registry.register(definition.stepType, definition.handler);
    const handler = registry.get("charge-card");

    expect(handler).toBeDefined();
    await expect(handler?.({ amount: 42 }, detachedStepContext())).resolves.toEqual({
      charged: true,
    });
  });

  it("carries a resolved retry policy onto the definition", () => {
    const definition = defineStep("charge", { handler: () => 1, retry: { maxAttempts: 7 } });
    expect(definition.retry).toMatchObject({ maxAttempts: 7, backoffCoefficient: 2 });
  });

  it("rejects an invalid retry policy", () => {
    expect(() => defineStep("charge", { handler: () => 1, retry: { maxAttempts: 0 } })).toThrow(
      RangeError,
    );
  });
});
