import { defineWorkflow } from "@dee/core";

export const workflows = [
  defineWorkflow("payment-saga", async (ctx, input: { readonly orderId: string }) =>
    ctx.step("payments.hold-funds", { orderId: input.orderId }),
  ),
];
