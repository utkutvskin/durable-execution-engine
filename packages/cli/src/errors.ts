/**
 * An error the cli reports as a plain message with a non zero exit code, as
 * opposed to a bug, which is reported with its stack.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/**
 * Raised when the api answers with an error status, or with an answer that
 * is not the json it documents. `retryAfterMs` is the wait the api asked for
 * with a `Retry-After` header, when it sent one.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
