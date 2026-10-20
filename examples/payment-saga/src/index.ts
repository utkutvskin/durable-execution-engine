import type { DemoContext, DemoReport } from "@dee/cli";
import { createInMemoryGateway, type InMemoryGateway } from "./gateway.js";
import { runPaymentDemo } from "./demo.js";
import { createPaymentSteps } from "./steps.js";
import { paymentSaga } from "./workflow.js";

export { CardDeclinedError, createInMemoryGateway } from "./gateway.js";
export type {
  Capture,
  InMemoryGateway,
  InMemoryGatewayOptions,
  PaymentGateway,
  Reservation,
  ReservationState,
  ReserveRequest,
} from "./gateway.js";
export { STEP_TYPES, createPaymentSteps } from "./steps.js";
export {
  APPROVAL_THRESHOLD_CENTS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  PAYMENT_SAGA,
  paymentSaga,
} from "./workflow.js";
export type { PaymentInput, PaymentResult } from "./workflow.js";
export { runPaymentDemo } from "./demo.js";

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
