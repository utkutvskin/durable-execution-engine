import { defineWorkflow } from "@dee/core";

export const workflows = [
  defineWorkflow("sample", async (ctx) => {
    const word = await ctx.step<string>("sample.shout", {});
    await ctx.sleep(1000);
    return word;
  }),
];
