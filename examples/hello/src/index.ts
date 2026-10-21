import { defineStep, defineWorkflow } from "@dee/core";

/**
 * The input of the `hello` workflow.
 */
export interface HelloInput {
  readonly name: string;
}

/**
 * The result of the `hello` workflow.
 */
export interface HelloResult {
  readonly greeting: string;
}

/**
 * A workflow that builds a greeting in a step, sleeps for a second and
 * returns the greeting. The sleep is a durable timer: a worker may stop and
 * another one finishes the run.
 */
export const hello = defineWorkflow<HelloInput, HelloResult>("hello", async (ctx, input) => {
  const greeting = await ctx.step<string>("hello.build-greeting", { name: input.name });
  await ctx.sleep(1000);
  return { greeting };
});

/**
 * The step `hello` runs. It has no side effect, so running it twice is safe.
 */
export const buildGreeting = defineStep<HelloInput, string>("hello.build-greeting", {
  handler: ({ name }) => `hello, ${name}`,
});

/**
 * The workflows this module contributes to `wf dev --module`.
 */
export const workflows = [hello];

/**
 * The steps this module contributes to `wf dev --module`.
 */
export const steps = [buildGreeting];
