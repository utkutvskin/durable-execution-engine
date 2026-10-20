import { defineWorkflow } from "@dee/core";
import type { Capture, Reservation } from "./gateway.js";
import { STEP_TYPES } from "./steps.js";

/**
 * Orders at or above this amount wait for a human approval before the card
 * is charged.
 */
export const APPROVAL_THRESHOLD_CENTS = 100_000;

/**
 * How long a large order waits for its approval when the input does not say.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * The input of the `payment-saga` workflow.
 */
export interface PaymentInput {
  readonly orderId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly approvalTimeoutMs?: number;
}

/**
 * How a saga ended. `captured` carries the charge and the receipt;
 * `compensated` says why the charge did not happen and that the hold was
 * lifted.
 */
export type PaymentResult =
  | {
      readonly status: "captured";
      readonly reservationId: string;
      readonly captureId: string;
      readonly receiptId: string;
    }
  | {
      readonly status: "compensated";
      readonly reservationId: string;
      readonly reason: string;
    };

/**
 * The name the saga is started under.
 */
export const PAYMENT_SAGA = "payment-saga";

/**
 * The payment saga: reserve funds, wait for an approval when the amount is
 * large, capture, and send a receipt. When the capture fails for good, or the
 * approval is refused or never comes, the hold is released and the run ends
 * `compensated`. When the run is cancelled while it waits, the registered
 * compensation releases the hold instead.
 */
export const paymentSaga = defineWorkflow(
  PAYMENT_SAGA,
  async (ctx, input: PaymentInput): Promise<PaymentResult> => {
    const reservation = await ctx.step<Reservation>(STEP_TYPES.reserve, {
      orderId: input.orderId,
      customerId: input.customerId,
      amountCents: input.amountCents,
    });
    const { reservationId } = reservation;
    ctx.onCancel(async (compensation) => {
      await compensation.step(STEP_TYPES.release, { reservationId });
    });

    const refuse = async (reason: string): Promise<PaymentResult> => {
      await ctx.step(STEP_TYPES.release, { reservationId });
      return { status: "compensated", reservationId, reason };
    };

    if (input.amountCents >= APPROVAL_THRESHOLD_CENTS) {
      const verdict = await ctx.select([
        ctx.waitForSignal<{ approved: boolean }>("approval"),
        ctx.sleep(input.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS),
      ]);
      if (verdict.index === 1) {
        return refuse("approval timed out");
      }
      if (!(verdict.value as { approved: boolean }).approved) {
        return refuse("approval refused");
      }
    }

    let capture: Capture;
    try {
      capture = await ctx.step<Capture>(STEP_TYPES.capture, {
        reservationId,
        amountCents: input.amountCents,
      });
    } catch (error) {
      return refuse(error instanceof Error ? error.message : "capture failed");
    }
    const receipt = await ctx.step<{ receiptId: string }>(STEP_TYPES.receipt, {
      orderId: input.orderId,
      captureId: capture.captureId,
    });
    return {
      status: "captured",
      reservationId,
      captureId: capture.captureId,
      receiptId: receipt.receiptId,
    };
  },
);
