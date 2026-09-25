import { defineWorkflow } from "../../../packages/core/src/workflow/define-workflow.js";
import type { WorkflowDefinition } from "../../../packages/core/src/workflow/workflow-registry.js";

export interface ShipOrderInput {
  readonly orderId: string;
  readonly amount: number;
}

export interface ShipOrderResult {
  readonly orderId: string;
  readonly shipped: boolean;
}

/**
 * The three-step example workflow the recorded history fixtures under
 * `test/fixtures/histories` were captured against: charge the card, wait
 * out a cooldown, reserve inventory, ship the package. Kept as its own
 * module, rather than redefined per test file, so a fixture's `history`
 * stays meaningful only as long as this handler's `ctx.step()` /
 * `ctx.sleep()` call sequence does not change.
 */
export function shipOrderWorkflow(): WorkflowDefinition<ShipOrderInput, ShipOrderResult> {
  return defineWorkflow<ShipOrderInput, ShipOrderResult>("ship-order", async (ctx, input) => {
    await ctx.step("charge-card", { amount: input.amount });
    await ctx.sleep(60_000);
    await ctx.step("reserve-inventory", { orderId: input.orderId });
    return ctx.step<ShipOrderResult>("ship-package", { orderId: input.orderId });
  });
}
