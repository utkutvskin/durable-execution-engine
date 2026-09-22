/**
 * Thrown by `EventStore.append` when `expectedSeq` no longer matches the
 * run's actual current sequence number, whether because a concurrent
 * append won a race or because the caller's history was stale. The append
 * is rejected as a whole: none of its events were written.
 */
export class ConcurrencyError extends Error {
  readonly runId: string;
  readonly expectedSeq: number;
  readonly actualSeq: number | undefined;

  constructor(runId: string, expectedSeq: number, actualSeq?: number) {
    const detail =
      actualSeq === undefined
        ? `expected sequence ${String(expectedSeq)} to still be current`
        : `expected sequence ${String(expectedSeq)}, found ${String(actualSeq)}`;
    super(`concurrent append to run "${runId}": ${detail}`);
    this.name = "ConcurrencyError";
    this.runId = runId;
    this.expectedSeq = expectedSeq;
    this.actualSeq = actualSeq;
  }
}
