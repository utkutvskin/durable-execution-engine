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

/**
 * Thrown by a `Codec`'s `encode` when the payload it produced is larger than
 * the codec's configured `maxPayloadBytes`. Raised before anything reaches
 * postgres, so a run never ends up with a partially written oversized
 * event: the caller sees this instead of a database error and can decide
 * how to shrink the payload (a reference instead of the value, a smaller
 * result) rather than losing the write silently to a truncated column.
 */
export class PayloadTooLargeError extends Error {
  readonly byteLength: number;
  readonly maxPayloadBytes: number;

  constructor(byteLength: number, maxPayloadBytes: number) {
    super(
      `payload is ${String(byteLength)} bytes, which exceeds the ${String(maxPayloadBytes)}-byte limit`,
    );
    this.name = "PayloadTooLargeError";
    this.byteLength = byteLength;
    this.maxPayloadBytes = maxPayloadBytes;
  }
}
