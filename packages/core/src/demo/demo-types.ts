import type { ScheduleManager } from "../schedules/schedule-manager.ts";

/**
 * A run as the api reports it, as far as an example scenario reads it.
 */
export interface DemoRunSnapshot {
  readonly runId: string;
  readonly workflowType: string;
  readonly status: string;
  readonly startedAt: string;
  readonly closedAt: string | null;
  readonly input?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly name: string; readonly message: string } | null;
}

/**
 * The client surface an example scenario drives runs with. The `wf` run
 * client satisfies it.
 */
export interface DemoRunClient {
  start(workflowType: string, input?: unknown, idempotencyKey?: string): Promise<string>;
  signal(runId: string, name: string, payload?: unknown): Promise<void>;
  cancel(runId: string, reason?: string): Promise<void>;
  describe(runId: string): Promise<DemoRunSnapshot>;
  waitForClose(
    runId: string,
    options?: { readonly timeoutMs?: number; readonly pollMs?: number },
  ): Promise<DemoRunSnapshot>;
}

/**
 * What a bundled example's scenarios get to work with.
 */
export interface DemoContext {
  readonly client: DemoRunClient;
  readonly schedules: ScheduleManager;
  readonly namespaceId: string;
  readonly log: (line: string) => void;
}

/**
 * What a scenario run reports: whether every scenario ended as expected and,
 * when not, what went wrong.
 */
export interface DemoReport {
  readonly ok: boolean;
  readonly problem?: string;
}
