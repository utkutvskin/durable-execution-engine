import { describe, expect, it } from "vitest";
import {
  ForbiddenApiError,
  guardAgainstForbiddenApis,
  runUnguarded,
  waitForMacrotask,
  WorkflowActiveAfterQuiescenceError,
} from "./sandbox.js";

const realSetTimeout = globalThis.setTimeout;

function refusedApi(call: () => unknown): string {
  try {
    call();
    return "allowed";
  } catch (error) {
    return error instanceof ForbiddenApiError ? error.api : "other";
  }
}

describe("guardAgainstForbiddenApis", () => {
  it("refuses Date.now, Math.random and setTimeout inside the guarded call chain", async () => {
    const outcomes = await guardAgainstForbiddenApis(async () => {
      await Promise.resolve();
      return [() => Date.now(), () => Math.random(), () => setTimeout(() => undefined, 1)].map(
        (call) => {
          try {
            call();
            return "allowed";
          } catch (error) {
            return error instanceof ForbiddenApiError ? error.api : "other";
          }
        },
      );
    });
    expect(outcomes).toEqual(["Date.now()", "Math.random()", "setTimeout()"]);
  });

  it("lets code outside the guarded call chain use the real functions while a guard is active", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guarded = guardAgainstForbiddenApis(() => held);
    const before = Date.now();
    expect(Date.now()).toBeGreaterThanOrEqual(before);
    expect(Math.random()).toBeGreaterThanOrEqual(0);
    const handle = setTimeout(() => undefined, 1);
    clearTimeout(handle);
    release();
    await guarded;
  });

  it("restores the globals once every guard has settled", async () => {
    const realNow = Date.now;
    await Promise.all([
      guardAgainstForbiddenApis(() => Promise.resolve()),
      guardAgainstForbiddenApis(() => Promise.resolve()),
    ]);
    expect(Date.now).toBe(realNow);
  });

  it("restores the globals when the guarded call rejects", async () => {
    const realRandom = Math.random;
    await expect(
      guardAgainstForbiddenApis(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(Math.random).toBe(realRandom);
  });

  it("keeps refusing after an await inside nested promise chains", async () => {
    const error = await guardAgainstForbiddenApis(async () => {
      await waitForMacrotask();
      try {
        Date.now();
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    });
    expect(error).toBeInstanceOf(ForbiddenApiError);
  });

  it("refuses new Date() and Date() inside a decision but not Date with an argument", async () => {
    const outcomes = await guardAgainstForbiddenApis(async () => {
      await Promise.resolve();
      return [
        refusedApi(() => new Date()),
        refusedApi(() => Date()),
        refusedApi(() => new Date(0)),
        refusedApi(() => new Date("2026-01-01T00:00:00.000Z")),
        refusedApi(() => Date.UTC(2026, 0, 1)),
      ];
    });
    expect(outcomes).toEqual(["new Date()", "Date()", "allowed", "allowed", "allowed"]);
  });

  it("keeps new Date() and Date() working outside a decision", async () => {
    expect(new Date().getTime()).toBeGreaterThan(0);
    expect(typeof Date()).toBe("string");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guarded = guardAgainstForbiddenApis(() => held);
    expect(new Date().getTime()).toBeGreaterThan(0);
    expect(typeof Date()).toBe("string");
    release();
    await guarded;
  });

  it("keeps instanceof Date and subclasses of Date working while patched", async () => {
    class Stamp extends Date {}
    const outcome = await guardAgainstForbiddenApis(async () => {
      await Promise.resolve();
      const stamp = new Stamp(5);
      return [new Date(5) instanceof Date, stamp instanceof Date, stamp.getTime()];
    });
    expect(outcome).toEqual([true, true, 5]);
  });

  it("refuses performance.now inside a decision and works outside one", async () => {
    const inside = await guardAgainstForbiddenApis(async () => {
      await Promise.resolve();
      return refusedApi(() => performance.now());
    });
    expect(inside).toBe("performance.now()");
    expect(performance.now()).toBeGreaterThan(0);
  });

  it("refuses crypto.randomUUID inside a decision and works outside one", async () => {
    const inside = await guardAgainstForbiddenApis(async () => {
      await Promise.resolve();
      return refusedApi(() => crypto.randomUUID());
    });
    expect(inside).toBe("crypto.randomUUID()");
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses setInterval inside a decision and works outside one", async () => {
    const inside = await guardAgainstForbiddenApis(async () => {
      await Promise.resolve();
      return refusedApi(() => setInterval(() => undefined, 1000));
    });
    expect(inside).toBe("setInterval()");
    const handle = setInterval(() => undefined, 1000);
    clearInterval(handle);
  });

  it("refuses setImmediate inside a decision and works outside one", async () => {
    const inside = await guardAgainstForbiddenApis(async () => {
      await Promise.resolve();
      return refusedApi(() => setImmediate(() => undefined));
    });
    expect(inside).toBe("setImmediate()");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });

  it("restores every patched global once the guard is released", async () => {
    const snapshot = (): unknown[] => [
      Date,
      Reflect.get(performance, "now"),
      Reflect.get(crypto, "randomUUID"),
      setInterval,
      setImmediate,
    ];
    const before = snapshot();
    await guardAgainstForbiddenApis(() => Promise.resolve());
    snapshot().forEach((value, index) => {
      expect(value).toBe(before[index]);
    });
  });

  it("runs code handed to runUnguarded with the real functions", async () => {
    const outcome = await guardAgainstForbiddenApis(async () => {
      await Promise.resolve();
      return runUnguarded(() => [new Date().getTime() > 0, Date.now() > 0, Math.random() >= 0]);
    });
    expect(outcome).toEqual([true, true, true]);
  });

  it("fails when code started inside the guard still waits on a timer after it", async () => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const error = await guardAgainstForbiddenApis(async () => {
      void new Promise<void>((resolve) => {
        handle = realSetTimeout(resolve, 5_000);
      });
      await waitForMacrotask();
    }).catch((thrown: unknown) => thrown);
    clearTimeout(handle);
    expect(error).toBeInstanceOf(WorkflowActiveAfterQuiescenceError);
    expect((error as WorkflowActiveAfterQuiescenceError).resources).toContain("Timeout");
  });

  it("fails when code started inside the guard still waits on a file read after it", async () => {
    const { readFile } = await import("node:fs/promises");
    const error = await guardAgainstForbiddenApis(async () => {
      void readFile("package.json");
      await waitForMacrotask();
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(WorkflowActiveAfterQuiescenceError);
  });

  it("does not fail for a timer the code cleared or for work that finished before the end", async () => {
    await expect(
      guardAgainstForbiddenApis(async () => {
        const handle = realSetTimeout(() => undefined, 5_000);
        clearTimeout(handle);
        await Promise.resolve();
        queueMicrotask(() => undefined);
        process.nextTick(() => undefined);
        await waitForMacrotask();
        return "quiet";
      }),
    ).resolves.toBe("quiet");
  });

  it("does not blame a guard for resources another guard started", async () => {
    let release: () => void = () => undefined;
    const other = guardAgainstForbiddenApis(async () => {
      const handle = realSetTimeout(() => undefined, 5_000);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      clearTimeout(handle);
    });
    await expect(guardAgainstForbiddenApis(() => waitForMacrotask())).resolves.toBeUndefined();
    release();
    await other;
  });

  it("keeps performance.now and crypto.randomUUID working for other code while a guard is active", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guarded = guardAgainstForbiddenApis(() => held);
    expect(performance.now()).toBeGreaterThan(0);
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
    release();
    await guarded;
  });
});
