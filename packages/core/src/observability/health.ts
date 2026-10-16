import type { Pool } from "pg";

/**
 * The result of a readiness check.
 */
export interface ReadinessResult {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, "ok" | "failed">>;
}

/**
 * Liveness and readiness probes. `live` only says the process runs and never
 * touches a dependency; `ready` says the database answers.
 */
export interface HealthChecks {
  live(): { readonly status: "ok" };
  ready(): Promise<ReadinessResult>;
}

/**
 * Options for `createHealthChecks`. `timeoutMs` bounds the database probe
 * (default 2000).
 */
export interface HealthChecksOptions {
  readonly timeoutMs?: number;
}

/**
 * Creates the probes over `pool`.
 */
export function createHealthChecks(pool: Pool, options: HealthChecksOptions = {}): HealthChecks {
  const timeoutMs = options.timeoutMs ?? 2000;

  async function probeDatabase(): Promise<"ok" | "failed"> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"failed">((resolve) => {
      handle = setTimeout(() => {
        resolve("failed");
      }, timeoutMs);
    });
    const query = pool.query("select 1").then(
      () => "ok" as const,
      () => "failed" as const,
    );
    const outcome = await Promise.race([query, timeout]);
    clearTimeout(handle);
    return outcome;
  }

  return {
    live: () => ({ status: "ok" }),
    async ready(): Promise<ReadinessResult> {
      const database = await probeDatabase();
      return { ready: database === "ok", checks: { database } };
    },
  };
}
