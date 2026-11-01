/**
 * The abort reason a task's signal carries when a heartbeat found that the
 * task's lease had expired or moved to another consumer.
 */
export class LeaseLostError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`lease for task ${taskId} was lost`);
    this.name = "LeaseLostError";
    this.taskId = taskId;
  }
}

/**
 * The abort reason a task's signal carries when a graceful shutdown ran out
 * of time and dropped the task.
 */
export class ShutdownTimeoutError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`task ${taskId} was dropped because the shutdown timeout elapsed`);
    this.name = "ShutdownTimeoutError";
    this.taskId = taskId;
  }
}

/**
 * Thrown by a task handler to say that redelivering the task cannot help until
 * an operator acts, for example deploys a build that knows the workflow. The
 * worker quarantines the task at once with the message as the reason.
 */
export class ParkTaskError extends Error {
  constructor(reason: string, options?: { readonly cause?: unknown }) {
    super(reason, options);
    this.name = "ParkTaskError";
  }
}
