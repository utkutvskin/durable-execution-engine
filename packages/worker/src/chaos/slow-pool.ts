import type { Pool } from "@dee/core";

const WRITE_STATEMENT = /^\s*(insert|update|delete|commit)\b/i;

function sqlOf(argument: unknown): string {
  if (typeof argument === "string") {
    return argument;
  }
  if (typeof argument === "object" && argument !== null && "text" in argument) {
    const text: unknown = argument.text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function withDelayedWrites<T extends object>(target: T, delayMs: () => number): T {
  return new Proxy(target, {
    get(object, property): unknown {
      const value: unknown = Reflect.get(object, property, object);
      if (property !== "query" || typeof value !== "function") {
        return typeof value === "function" ? (value as () => unknown).bind(object) : value;
      }
      return async (...args: unknown[]): Promise<unknown> => {
        if (WRITE_STATEMENT.test(sqlOf(args[0]))) {
          const delay = delayMs();
          if (delay > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
          }
        }
        return (value as (...inner: unknown[]) => Promise<unknown>).apply(object, args);
      };
    },
  });
}

/**
 * Wraps `pool` so every write statement (`insert`, `update`, `delete` and
 * `commit`, on the pool or on a client taken from it) waits `delayMs()`
 * milliseconds before it runs. This stands in for a disk whose fsync is slow:
 * transactions stay open longer, locks are held longer and leases expire in
 * the middle of writes. Reads are not delayed.
 */
export function createSlowDiskPool(pool: Pool, delayMs: () => number): Pool {
  return new Proxy(pool, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "query") {
        const delayed = withDelayedWrites(target, delayMs);
        return (...args: Parameters<Pool["query"]>): unknown =>
          (delayed.query as (...inner: unknown[]) => unknown)(...args);
      }
      if (property === "connect") {
        return async (...args: unknown[]): Promise<unknown> => {
          const client = await (value as (...inner: unknown[]) => Promise<object>).apply(
            target,
            args,
          );
          return withDelayedWrites(client, delayMs);
        };
      }
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
}
