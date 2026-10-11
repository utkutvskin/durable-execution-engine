import type { WorkflowEvent } from "../event-store/events.js";
import type { WorkflowHandler } from "../workflow/context.js";
import {
  runDecisionLoop,
  type DecisionLoopOptions,
  type DecisionResult,
} from "../workflow/decision-loop.js";
import { createLiveSession, type LiveSession } from "../workflow/live-session.js";
import type { RunCache } from "./run-cache.js";

/**
 * How a `StickyDecider` reached a decision: `cache` advanced a live session
 * with only the events recorded since the previous task, `replay` ran the
 * workflow from the top.
 */
export type DecisionSource = "cache" | "replay";

/**
 * A decision together with how it was reached.
 */
export interface StickyDecision {
  readonly decision: DecisionResult;
  readonly source: DecisionSource;
}

/**
 * Counters a `StickyDecider` keeps. `fullReplays` counts workflow handler
 * runs from the top of the history, whatever the reason; `replayedEvents`
 * counts the history events those runs consumed, and `incrementalEvents`
 * the events fed to cached sessions instead. `invalidations` counts cached
 * sessions dropped because they no longer matched the history.
 */
export interface StickyDeciderStats {
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly fullReplays: number;
  readonly replayedEvents: number;
  readonly incrementalEvents: number;
  readonly invalidations: number;
}

/**
 * Decides a run's next step while keeping each run's workflow alive in a
 * `RunCache`, so a task replays only the events that are new.
 */
export interface StickyDecider {
  decide<TInput, TResult>(
    runId: string,
    handler: WorkflowHandler<TInput, TResult>,
    input: TInput,
    history: readonly WorkflowEvent[],
  ): Promise<StickyDecision>;
  invalidate(runId: string): void;
  flush(): void;
  stats(): StickyDeciderStats;
}

/**
 * What `createStickyDecider` needs: the cache to keep sessions in and the
 * options every decision runs with.
 */
export interface StickyDeciderOptions {
  readonly cache: RunCache<LiveSession>;
  readonly decisionOptions: DecisionLoopOptions;
}

/**
 * Creates a `StickyDecider`. Every decision equals what `runDecisionLoop`
 * returns for the same history: a cache miss, an expired or flushed entry, a
 * history that does not continue what a session has seen (including commands
 * of the previous decision that never got recorded), and a workflow that uses
 * features a live session cannot resume (children, parallel helpers,
 * `select`, compensation handlers, `continueAsNew`) all fall back to a full
 * replay. A decision that closes the run, and any error, drops the session.
 */
export function createStickyDecider(options: StickyDeciderOptions): StickyDecider {
  const { cache, decisionOptions } = options;
  const uncacheable = new WeakSet();
  let cacheHits = 0;
  let cacheMisses = 0;
  let fullReplays = 0;
  let replayedEvents = 0;
  let incrementalEvents = 0;
  let invalidations = 0;

  function isOpen(decision: DecisionResult): boolean {
    return decision.outcome === "suspended";
  }

  async function replayFromScratch<TInput, TResult>(
    runId: string,
    handler: WorkflowHandler<TInput, TResult>,
    input: TInput,
    history: readonly WorkflowEvent[],
  ): Promise<StickyDecision> {
    if (!uncacheable.has(handler)) {
      const session = createLiveSession(handler, input, decisionOptions);
      fullReplays += 1;
      replayedEvents += history.length;
      const advanced = await session.advance(history);
      if (advanced.status === "decided") {
        if (isOpen(advanced.decision)) {
          cache.set(runId, session);
        }
        return { decision: advanced.decision, source: "replay" };
      }
      uncacheable.add(handler);
    }
    fullReplays += 1;
    replayedEvents += history.length;
    const decision = await runDecisionLoop(handler, input, history, decisionOptions);
    return { decision, source: "replay" };
  }

  return {
    async decide<TInput, TResult>(
      runId: string,
      handler: WorkflowHandler<TInput, TResult>,
      input: TInput,
      history: readonly WorkflowEvent[],
    ): Promise<StickyDecision> {
      const cached = cache.get(runId);
      if (cached === undefined) {
        cacheMisses += 1;
      } else {
        const before = cached.eventCount;
        try {
          const advanced = await cached.advance(history);
          if (advanced.status === "decided") {
            cacheHits += 1;
            incrementalEvents += history.length - before;
            if (isOpen(advanced.decision)) {
              cache.set(runId, cached);
            } else {
              cache.delete(runId);
            }
            return { decision: advanced.decision, source: "cache" };
          }
        } catch (error: unknown) {
          cache.delete(runId);
          throw error;
        }
        cacheMisses += 1;
        invalidations += 1;
        cache.delete(runId);
      }
      try {
        return await replayFromScratch(runId, handler, input, history);
      } catch (error: unknown) {
        cache.delete(runId);
        throw error;
      }
    },

    invalidate(runId: string): void {
      if (cache.delete(runId)) {
        invalidations += 1;
      }
    },

    flush(): void {
      cache.clear();
    },

    stats(): StickyDeciderStats {
      return {
        cacheHits,
        cacheMisses,
        fullReplays,
        replayedEvents,
        incrementalEvents,
        invalidations,
      };
    },
  };
}
