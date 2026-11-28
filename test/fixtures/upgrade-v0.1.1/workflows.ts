import { defineStep, defineWorkflow } from "../../../packages/core/src/index.ts";
import type {
  AnyStepDefinition,
  AnyWorkflowDefinition,
} from "../../../packages/worker/src/index.ts";

/**
 * The type of every workflow the v0.1.1 upgrade fixture leaves behind. The
 * same definitions are registered by the v0.1.1 engine that recorded the
 * fixture and by the current engine that finishes its runs, so this file
 * only uses API that both versions share.
 */
export const UPGRADE_WORKFLOW_TYPES = {
  approval: "upgrade.approval",
  sleeper: "upgrade.sleeper",
  parent: "upgrade.parent",
  retrying: "upgrade.retrying",
  queued: "upgrade.queued",
} as const;

/**
 * The duration of the durable sleep of `upgrade.sleeper` and the first
 * retry interval of `upgrade.flaky`, long enough to be pending when the
 * recorder dumps the database and over by the time the upgrade test runs.
 */
export const UPGRADE_WAIT_MS = 30_000;

/**
 * Options of `createUpgradeDefinitions`. `flakyFails` makes `upgrade.flaky`
 * throw, which the recorder uses to leave a step waiting for its retry.
 * `calls` counts every handler call by step type.
 */
export interface UpgradeDefinitionOptions {
  readonly flakyFails: boolean;
  readonly calls: Map<string, number>;
}

/**
 * The workflows and steps of the v0.1.1 upgrade fixture, ready for
 * `startEngine`.
 */
export interface UpgradeDefinitions {
  readonly workflows: readonly AnyWorkflowDefinition[];
  readonly steps: readonly AnyStepDefinition[];
}

/**
 * Builds the workflows and steps of the v0.1.1 upgrade fixture.
 */
export function createUpgradeDefinitions(options: UpgradeDefinitionOptions): UpgradeDefinitions {
  const count = (stepType: string): void => {
    options.calls.set(stepType, (options.calls.get(stepType) ?? 0) + 1);
  };
  const reserve = defineStep<{ order: string }, string>("upgrade.reserve", {
    handler: ({ order }) => {
      count("upgrade.reserve");
      return `reserved ${order}`;
    },
  });
  const capture = defineStep<{ order: string; approver: string }, string>("upgrade.capture", {
    handler: ({ order, approver }) => {
      count("upgrade.capture");
      return `captured ${order} for ${approver}`;
    },
  });
  const flaky = defineStep<{ order: string }, string>("upgrade.flaky", {
    retry: { initialIntervalMs: UPGRADE_WAIT_MS, maxAttempts: 5, jitter: 0 },
    handler: ({ order }) => {
      count("upgrade.flaky");
      if (options.flakyFails) {
        throw new Error(`the ledger is down for ${order}`);
      }
      return `booked ${order}`;
    },
  });

  const approval = defineWorkflow(
    UPGRADE_WORKFLOW_TYPES.approval,
    async (ctx, input: { order: string }) => {
      const reserved = await ctx.step<string>("upgrade.reserve", input);
      const decision = await ctx.waitForSignal<{ approver: string }>("approve");
      const captured = await ctx.step<string>("upgrade.capture", {
        order: input.order,
        approver: decision.approver,
      });
      return { reserved, captured };
    },
  );
  const sleeper = defineWorkflow(
    UPGRADE_WORKFLOW_TYPES.sleeper,
    async (ctx, input: { order: string }) => {
      const reserved = await ctx.step<string>("upgrade.reserve", input);
      await ctx.sleep(UPGRADE_WAIT_MS);
      const captured = await ctx.step<string>("upgrade.capture", {
        order: input.order,
        approver: "timer",
      });
      return { reserved, captured };
    },
  );
  const parent = defineWorkflow(
    UPGRADE_WORKFLOW_TYPES.parent,
    async (ctx, input: { order: string }) => {
      const reserved = await ctx.step<string>("upgrade.reserve", input);
      const child = await ctx.executeChild<{ captured: string }>(UPGRADE_WORKFLOW_TYPES.approval, {
        order: `${input.order}-child`,
      });
      return { reserved, child: child.captured };
    },
  );
  const retrying = defineWorkflow(
    UPGRADE_WORKFLOW_TYPES.retrying,
    async (ctx, input: { order: string }) => {
      const booked = await ctx.step<string>("upgrade.flaky", input);
      return { booked };
    },
  );
  const queued = defineWorkflow(
    UPGRADE_WORKFLOW_TYPES.queued,
    async (ctx, input: { order: string }) => {
      const reserved = await ctx.step<string>("upgrade.reserve", input);
      return { reserved };
    },
  );

  return {
    workflows: [approval, sleeper, parent, retrying, queued],
    steps: [reserve, capture, flaky],
  };
}
