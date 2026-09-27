import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineStep, registerStep } from "./define-step.js";
import { StepTimeoutError } from "./errors.js";
import { createStepRegistry } from "./step-registry.js";

describe("defineStep", () => {
  it("runs the handler and returns its result", async () => {
    const chargeCard = defineStep<{ amount: number }, { charged: boolean }>({
      stepType: "charge-card",
      handler: (input) => ({ charged: input.amount > 0 }),
    });

    await expect(chargeCard.execute({ amount: 10 })).resolves.toEqual({ charged: true });
  });

  it("awaits an async handler", async () => {
    const step = defineStep<number, number>({
      stepType: "double",
      handler: async (input) => Promise.resolve(input * 2),
    });

    await expect(step.execute(21)).resolves.toBe(42);
  });

  it("rejects input that does not satisfy inputSchema before the handler ever runs", async () => {
    const handler = vi.fn((input: { amount: number }) => ({ charged: input.amount > 0 }));
    const step = defineStep({
      stepType: "charge-card",
      inputSchema: z.object({ amount: z.number().positive() }),
      handler,
    });

    await expect(step.execute({ amount: -5 })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a result that does not satisfy resultSchema", async () => {
    const step = defineStep<number, { charged: boolean }>({
      stepType: "charge-card",
      resultSchema: z.object({ charged: z.boolean() }),
      handler: () => ({ charged: "yes" }) as unknown as { charged: boolean },
    });

    await expect(step.execute(10)).rejects.toThrow();
  });

  describe("timeoutMs", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects with StepTimeoutError when the handler outlives its timeout", async () => {
      const step = defineStep<undefined>({
        stepType: "slow-step",
        timeoutMs: 1000,
        handler: () => new Promise(() => undefined),
      });

      const outcome = step.execute(undefined);
      const assertion = expect(outcome).rejects.toBeInstanceOf(StepTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    });

    it("resolves normally when the handler settles before its timeout", async () => {
      const step = defineStep<undefined, string>({
        stepType: "fast-step",
        timeoutMs: 1000,
        handler: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve("done");
            }, 10);
          }),
      });

      const outcome = step.execute(undefined);
      await vi.advanceTimersByTimeAsync(10);
      await expect(outcome).resolves.toBe("done");
    });
  });
});

describe("registerStep", () => {
  it("registers a step definition so the registry looks it up by stepType", async () => {
    const registry = createStepRegistry();
    const step = defineStep<number, number>({ stepType: "double", handler: (input) => input * 2 });

    registerStep(registry, step);
    const handler = registry.get("double");

    expect(handler).toBeDefined();
    await expect(Promise.resolve(handler?.(21))).resolves.toBe(42);
  });
});
