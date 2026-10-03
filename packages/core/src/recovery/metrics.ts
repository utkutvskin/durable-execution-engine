/**
 * A point-in-time copy of the recovery counters. `reclaimedByWorker` is keyed
 * by the worker id stamped on the orphaned lease, with `unknown` for leases
 * taken without an identity.
 */
export interface RecoveryMetricsSnapshot {
  readonly sweeps: number;
  readonly leasesReclaimed: number;
  readonly stalledRunsDetected: number;
  readonly stalledRunsRecovered: number;
  readonly reclaimedByWorker: Readonly<Record<string, number>>;
  readonly lastSweepAt: Date | undefined;
}

/**
 * In-process counters a janitor updates on every sweep. Exposing them to
 * Prometheus is the metrics day's job; this is the source it will read.
 */
export interface RecoveryMetrics {
  recordSweep(at: Date): void;
  recordReclaimed(workerId: string | null): void;
  recordStalledDetected(count: number): void;
  recordStalledRecovered(count: number): void;
  snapshot(): RecoveryMetricsSnapshot;
}

/**
 * Creates an empty `RecoveryMetrics`.
 */
export function createRecoveryMetrics(): RecoveryMetrics {
  let sweeps = 0;
  let leasesReclaimed = 0;
  let stalledRunsDetected = 0;
  let stalledRunsRecovered = 0;
  let lastSweepAt: Date | undefined;
  const reclaimedByWorker = new Map<string, number>();

  return {
    recordSweep(at: Date): void {
      sweeps += 1;
      lastSweepAt = at;
    },
    recordReclaimed(workerId: string | null): void {
      leasesReclaimed += 1;
      const key = workerId ?? "unknown";
      reclaimedByWorker.set(key, (reclaimedByWorker.get(key) ?? 0) + 1);
    },
    recordStalledDetected(count: number): void {
      stalledRunsDetected += count;
    },
    recordStalledRecovered(count: number): void {
      stalledRunsRecovered += count;
    },
    snapshot(): RecoveryMetricsSnapshot {
      return {
        sweeps,
        leasesReclaimed,
        stalledRunsDetected,
        stalledRunsRecovered,
        reclaimedByWorker: Object.fromEntries(reclaimedByWorker),
        lastSweepAt,
      };
    },
  };
}
