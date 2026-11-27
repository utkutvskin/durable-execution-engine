import type { Pool } from "@dee/core";

/**
 * A pool whose connection to the database can be cut at once, and the
 * function that cuts it.
 */
export interface SeverablePool {
  readonly pool: Pool;
  sever(): void;
}

/**
 * Thrown by every statement sent through a severed pool.
 */
export class SeveredPoolError extends Error {
  constructor() {
    super("the pool was severed from the database");
    this.name = "SeveredPoolError";
  }
}

function failingQueries<T extends object>(target: T, isSevered: () => boolean): T {
  return new Proxy(target, {
    get(object, property): unknown {
      const value: unknown = Reflect.get(object, property, object);
      if (property !== "query" || typeof value !== "function") {
        return typeof value === "function" ? (value as () => unknown).bind(object) : value;
      }
      return (...args: unknown[]): unknown =>
        isSevered()
          ? Promise.reject(new SeveredPoolError())
          : (value as (...inner: unknown[]) => unknown).apply(object, args);
    },
  });
}

/**
 * Wraps `pool` so that after `sever()` every statement, on the pool or on a
 * client already taken from it, rejects with `SeveredPoolError` and no new
 * client can be taken. An engine running on it behaves like a process that
 * crashed at that moment: it can neither ack, nack nor extend its leases, so
 * they stay as they were until they expire. Statements already sent finish.
 */
export function createSeverablePool(pool: Pool): SeverablePool {
  let severed = false;
  const isSevered = (): boolean => severed;
  const wrapped = new Proxy(pool, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "query") {
        return (failingQueries(target, isSevered).query as (...inner: unknown[]) => unknown).bind(
          target,
        );
      }
      if (property === "connect") {
        return async (...args: unknown[]): Promise<unknown> => {
          if (severed) {
            throw new SeveredPoolError();
          }
          const client = await (value as (...inner: unknown[]) => Promise<object>).apply(
            target,
            args,
          );
          return failingQueries(client, isSevered);
        };
      }
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  return {
    pool: wrapped,
    sever(): void {
      severed = true;
    },
  };
}
