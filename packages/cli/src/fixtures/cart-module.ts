import { defineStep, defineUpdate, defineWorkflow } from "@dee/core";

export const workflows = [
  defineWorkflow("cart", async (ctx) => {
    const items: string[] = [];
    let total = 0;
    ctx.setQueryHandler("items", () => [...items]);
    ctx.setUpdateHandler(
      defineUpdate<string, number>("add", {
        validate: (sku) => {
          if (typeof sku !== "string" || sku.length === 0) {
            throw new Error("a sku must be a non-empty string");
          }
          if (items.includes(sku)) {
            throw new Error(`${sku} is in the cart already`);
          }
        },
        handler: async (sku) => {
          items.push(sku);
          total += await ctx.step<number>("cart.price", { sku });
          return total;
        },
      }),
    );
    await ctx.waitForSignal("checkout");
    return { items, total };
  }),
];

export const steps = [
  defineStep("cart.price", {
    handler: (input: { readonly sku: string }) => input.sku.length * 100,
  }),
];
