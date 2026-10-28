import type { WorkflowCommand } from "./commands.js";
import type { DecisionLoopOptions } from "./decision-loop.js";
import { createSeededRandomSource } from "./seeded-random.js";
import { runUnguarded } from "./sandbox.js";

/**
 * The three values a workflow reads from its context, as one replay or live
 * session serves them.
 */
export interface ContextValues {
  readonly now: () => Date;
  readonly random: () => number;
  readonly uuid: () => string;
}

/**
 * Builds the `ctx.now()`, `ctx.random()` and `ctx.uuid()` of one replay or
 * live session. The nth `now` call returns the nth time in `recordedTimes`
 * (the `time_recorded` events of the history, in order); past the recorded
 * ones it answers with the time of the triggering event
 * (`options.triggeredAt`, else `options.clock`) and hands the answer to
 * `record` so the decision stores it. `random` and `uuid` come from
 * `options.random` when given, else from a generator seeded by
 * `options.runId` and a per-run counter, so replays draw the same values.
 * The sources are called outside the forbidden API guard.
 */
export function createContextValues(
  options: DecisionLoopOptions,
  recordedTimes: readonly string[],
  triggeredAt: () => Date | undefined,
  record: (command: WorkflowCommand) => void,
): ContextValues {
  const random = options.random ?? createSeededRandomSource(options.runId ?? "");
  let timeCalls = 0;
  return {
    now(): Date {
      const index = timeCalls;
      timeCalls += 1;
      const recorded = recordedTimes[index];
      if (recorded !== undefined) {
        return new Date(recorded);
      }
      const time = triggeredAt() ?? runUnguarded(() => options.clock.now());
      record({ type: "record_time", time: time.toISOString() });
      return new Date(time.getTime());
    },
    random: () => runUnguarded(() => random.random()),
    uuid: () => runUnguarded(() => random.uuid()),
  };
}
