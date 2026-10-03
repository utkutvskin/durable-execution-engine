import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/**
 * Who a worker is: a unique `id` for this process and the `version` of the
 * code it runs. Both are stamped on every task the worker leases, so a
 * reclaimed lease names the worker that lost it.
 */
export interface WorkerIdentity {
  readonly id: string;
  readonly version: string;
}

/**
 * Options for `createWorkerIdentity`. Every field except `version` exists so
 * tests can pin the generated id.
 */
export interface WorkerIdentityOptions {
  readonly version: string;
  readonly host?: string;
  readonly pid?: number;
  readonly suffix?: string;
}

/**
 * Builds a `WorkerIdentity` whose id is `host-pid-suffix`, with a random
 * suffix by default so a restarted process never reuses its predecessor's
 * id.
 */
export function createWorkerIdentity(options: WorkerIdentityOptions): WorkerIdentity {
  if (options.version.length === 0) {
    throw new RangeError("version must not be empty");
  }
  const host = options.host ?? hostname();
  const pid = options.pid ?? process.pid;
  const suffix = options.suffix ?? randomUUID().slice(0, 8);
  return { id: `${host}-${String(pid)}-${suffix}`, version: options.version };
}
