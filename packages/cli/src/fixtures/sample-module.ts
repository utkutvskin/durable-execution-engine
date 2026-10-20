import { defineStep, defineWorkflow } from "@dee/core";

export const workflows = [defineWorkflow("sample", (ctx) => ctx.step<string>("sample.shout", {}))];

export const steps = [defineStep("sample.shout", { handler: () => "HELLO" })];
