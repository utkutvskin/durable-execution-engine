import { defineStep, type StepDefinition } from "@dee/core";
import type { PaymentGateway, Reservation, ReserveRequest } from "./gateway.js";

/**
 * The step types of the saga, as `ctx.step()` names them.
 */
export const STEP_TYPES = {
  reserve: "payments.reserve",
  capture: "payments.capture",
  release: "payments.release",
  receipt: "payments.send-receipt",
} as const;

/**
 * What the capture step needs.
 */
export interface CaptureInput {
  readonly reservationId: string;
  readonly amountCents: number;
}

/**
 * What the release step needs.
 */
export interface ReleaseInput {
  readonly reservationId: string;
}

/**
 * What the receipt step needs.
 */
export interface ReceiptInput {
  readonly orderId: string;
  readonly captureId: string;
}

/**
 * Builds the steps of the saga over `gateway`. Capture retries transient
 * failures with a short backoff and gives up at once on a declined card.
 */
export function createPaymentSteps(gateway: PaymentGateway): readonly StepDefinition<never>[] {
  const reserve = defineStep<ReserveRequest, Reservation>(STEP_TYPES.reserve, {
    handler: (input) => gateway.reserve(input),
  });
  const capture = defineStep(STEP_TYPES.capture, {
    retry: {
      initialIntervalMs: 100,
      backoffCoefficient: 2,
      maxAttempts: 4,
      nonRetryableErrorNames: ["CardDeclinedError"],
    },
    handler: (input: CaptureInput) => gateway.capture(input.reservationId, input.amountCents),
  });
  const release = defineStep(STEP_TYPES.release, {
    handler: async (input: ReleaseInput) => {
      await gateway.release(input.reservationId);
      return { released: input.reservationId };
    },
  });
  const receipt = defineStep(STEP_TYPES.receipt, {
    handler: (input: ReceiptInput) => ({ receiptId: `rcpt-${input.orderId}` }),
  });
  return [reserve, capture, release, receipt];
}
