import type { DemoContext, DemoReport } from "@dee/core";
import { createInMemoryGateway, type InMemoryGateway } from "./gateway.ts";
import { runPaymentDemo } from "./demo.ts";
import { createPaymentSteps } from "./steps.ts";
import { paymentSaga } from "./workflow.ts";

export { CardDeclinedError, createInMemoryGateway } from "./gateway.ts";
export type {
  Capture,
  InMemoryGateway,
  InMemoryGatewayOptions,
  PaymentGateway,
  Reservation,
  ReservationState,
  ReserveRequest,
} from "./gateway.ts";
export { STEP_TYPES, createPaymentSteps } from "./steps.ts";
export {
  APPROVAL_THRESHOLD_CENTS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  PAYMENT_SAGA,
  paymentSaga,
} from "./workflow.ts";
export type { PaymentInput, PaymentResult } from "./workflow.ts";
export { runPaymentDemo } from "./demo.ts";

/**
 * Creates the in-memory gateway the demo scenarios expect: it refuses
 * `customer-declined` and fails the first capture of `customer-flaky`.
 */
export function createDemoGateway(): InMemoryGateway {
  return createInMemoryGateway({
    declineCustomers: ["customer-declined"],
    failFirstCaptures: ["customer-flaky"],
  });
}

/**
 * The gateway the exported `steps` talk to.
 */
export const gateway: InMemoryGateway = createDemoGateway();

/**
 * The workflows this example contributes to a worker.
 */
export const workflows = [paymentSaga];

/**
 * The steps this example contributes to a worker, running against `gateway`.
 */
export const steps = createPaymentSteps(gateway);

/**
 * What `wf example payment-saga` runs.
 */
export const demo = {
  description: "reserve, approve, capture and compensate card payments",
  run: (context: DemoContext): Promise<DemoReport> => runPaymentDemo(context, gateway),
};
