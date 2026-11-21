import type { Pool } from "pg";

/**
 * A pool wrapper that records the SQL text of every statement sent through
 * it, on the pool itself or on a client taken from it.
 */
export interface CountingPool {
  readonly pool: Pool;
  readonly statements: readonly string[];
  /** Forgets every statement recorded so far. */
  reset(): void;
}

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

function recording<T extends object>(target: T, record: (sql: string) => void): T {
  return new Proxy(target, {
    get(object, property): unknown {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== "function") {
        return value;
      }
      if (property !== "query") {
        return (value as () => unknown).bind(object);
      }
      return (...args: unknown[]): unknown => {
        record(sqlOf(args[0]));
        return (value as (...inner: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

/**
 * Wraps `pool` so every statement is recorded in `statements`, in the order
 * it was sent. `begin` and `commit` count as statements, since each is a
 * round trip to the database.
 */
export function createCountingPool(pool: Pool): CountingPool {
  const statements: string[] = [];
  const record = (sql: string): void => {
    statements.push(sql.replace(/\s+/g, " ").trim());
  };
  const wrapped = new Proxy(pool, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "query") {
        return (...args: unknown[]): unknown => {
          record(sqlOf(args[0]));
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      if (property === "connect") {
        return async (...args: unknown[]): Promise<unknown> => {
          const client = await (value as (...inner: unknown[]) => Promise<object>).apply(
            target,
            args,
          );
          return recording(client, record);
        };
      }
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  return {
    pool: wrapped,
    statements,
    reset(): void {
      statements.length = 0;
    },
  };
}
