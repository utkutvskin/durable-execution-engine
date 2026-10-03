import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CrashPoint } from "./flow.js";

/**
 * How to start a chaos child: the schema and queue it works on, the
 * checkpoint at which it parks itself (none runs to completion) and the
 * version it stamps on its leases.
 */
export interface ChaosChildOptions {
  readonly schema: string;
  readonly queueName: string;
  readonly crashPoint?: CrashPoint;
  readonly version?: string;
}

/**
 * A worker running in its own operating system process.
 */
export interface ChaosChild {
  readonly pid: number;
  /** Resolves with the first output line that starts with `prefix`. */
  waitForLine(prefix: string): Promise<string>;
  /** Sends `signal` and resolves with the exit code and signal once the process is gone. */
  kill(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const registerPath = fileURLToPath(new URL("./register.ts", import.meta.url));
const childPath = fileURLToPath(new URL("./child-worker.ts", import.meta.url));

/**
 * Starts the sample flow's worker as a separate Node process running the
 * workspace's TypeScript sources. The process inherits `DATABASE_URL` and the
 * `POSTGRES_*` variables of the caller.
 */
export function spawnChaosChild(options: ChaosChildOptions): ChaosChild {
  const child: ChildProcess = spawn(process.execPath, ["--import", registerPath, childPath], {
    env: {
      ...process.env,
      DEE_CHAOS_SCHEMA: options.schema,
      DEE_CHAOS_QUEUE: options.queueName,
      DEE_CHAOS_VERSION: options.version ?? "0.0.0",
      ...(options.crashPoint === undefined ? {} : { DEE_CHAOS_CRASH_POINT: options.crashPoint }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const listeners = new Set<() => void>();
  let buffered = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts);
    listeners.forEach((listener) => {
      listener();
    });
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
      listeners.forEach((listener) => {
        listener();
      });
    });
  });

  return {
    pid: child.pid ?? -1,
    waitForLine(prefix: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const check = (): void => {
          const found = lines.find((line) => line.startsWith(prefix));
          if (found !== undefined) {
            listeners.delete(check);
            resolve(found);
            return;
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            listeners.delete(check);
            reject(new Error(`child exited before printing "${prefix}": ${stderr}`));
          }
        };
        listeners.add(check);
        check();
      });
    },
    kill(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
      child.kill(signal);
      return exited;
    },
  };
}
