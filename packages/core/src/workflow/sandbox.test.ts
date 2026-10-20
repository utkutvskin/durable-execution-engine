import { describe, expect, it } from "vitest";
import { ForbiddenApiError, guardAgainstForbiddenApis } from "./sandbox.js";

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
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      try {
        Date.now();
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    });
    expect(error).toBeInstanceOf(ForbiddenApiError);
  });
});
