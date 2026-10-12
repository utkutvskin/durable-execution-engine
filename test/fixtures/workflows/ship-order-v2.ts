import { defineWorkflow } from "../../../packages/core/src/workflow/define-workflow.js";
import type { WorkflowDefinition } from "../../../packages/core/src/workflow/workflow-registry.js";
import type { ShipOrderInput, ShipOrderResult } from "./ship-order.js";

/**
 * The second version of the `ship-order` workflow: a `fraud-check` step is
 * added after the cooldown, gated by `ctx.patched("fraud-check")`. Runs whose
 * recorded history already moved past the gate on the first version keep the
 * first version's behavior; every other run takes the new step.
 */
export function shipOrderV2Workflow(): WorkflowDefinition<ShipOrderInput, ShipOrderResult> {
  return defineWorkflow<ShipOrderInput, ShipOrderResult>("ship-order", async (ctx, input) => {
    await ctx.step("charge-card", { amount: input.amount });
    await ctx.sleep(60_000);
    if (ctx.patched("fraud-check")) {
      await ctx.step("fraud-check", { orderId: input.orderId });
    }
    await ctx.step("reserve-inventory", { orderId: input.orderId });
    return ctx.step<ShipOrderResult>("ship-package", { orderId: input.orderId });
  });
}
