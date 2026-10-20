import type { DemoContext, DemoReport, RunSnapshot } from "@dee/cli";
import type { InMemoryGateway } from "./gateway.js";
import { PAYMENT_SAGA, type PaymentInput, type PaymentResult } from "./workflow.js";

/**
 * The story `wf example payment-saga` plays through the api: five orders that
 * show a plain payment, an approval, a declined card, a transient provider
 * failure and a cancellation. Each outcome is checked against the run and
 * against what the gateway actually did. The gateway must refuse
 * `customer-declined` and fail the first capture of `customer-flaky`, as the
 * one `createDemoGateway` builds does.
 */
export async function runPaymentDemo(
  context: DemoContext,
  gateway: InMemoryGateway,
): Promise<DemoReport> {
  const { client, log } = context;
  const problems: string[] = [];
  gateway.reset();

  function expect(condition: boolean, message: string): void {
    log(`${condition ? "  ok " : "  bad"} ${message}`);
    if (!condition) {
      problems.push(message);
    }
  }

  function resultOf(run: RunSnapshot): PaymentResult | undefined {
    return run.result as PaymentResult | undefined;
  }

  const start = (input: PaymentInput): Promise<string> => client.start(PAYMENT_SAGA, input);

  log("1. a small order is reserved, captured and receipted");
  const plain = await client.waitForClose(
    await start({ orderId: "order-1", customerId: "customer-1", amountCents: 4_999 }),
  );
  expect(resultOf(plain)?.status === "captured", "the order was captured");
  expect(gateway.reservations().get("res-order-1") === "CAPTURED", "the hold became a charge");

  log("2. a large order waits for an approval signal");
  const large = await start({ orderId: "order-2", customerId: "customer-2", amountCents: 250_000 });
  await client.signal(large, "approval", { approved: true });
  const approved = await client.waitForClose(large);
  expect(resultOf(approved)?.status === "captured", "the approved order was captured");

  log("3. a declined card releases the hold and ends compensated");
  const declined = await client.waitForClose(
    await start({ orderId: "order-3", customerId: "customer-declined", amountCents: 1_500 }),
  );
  expect(resultOf(declined)?.status === "compensated", "the order ended compensated");
  expect(gateway.reservations().get("res-order-3") === "RELEASED", "the hold was released");
  expect(
    (gateway.captureCalls().get("res-order-3") ?? 0) === 1,
    "a declined card was tried once, not retried",
  );

  log("4. a provider timeout is retried and the order still completes");
  const retried = await client.waitForClose(
    await start({ orderId: "order-4", customerId: "customer-flaky", amountCents: 900 }),
  );
  expect(resultOf(retried)?.status === "captured", "the order was captured after a retry");
  expect(
    (gateway.captureCalls().get("res-order-4") ?? 0) === 2,
    "the provider was called twice, once failing and once succeeding",
  );

  log("5. cancelling a run that waits for approval releases its hold");
  const waiting = await start({
    orderId: "order-5",
    customerId: "customer-5",
    amountCents: 500_000,
  });
  for (
    let attempt = 0;
    attempt < 200 && gateway.reservations().get("res-order-5") !== "HELD";
    attempt += 1
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  await client.cancel(waiting, "customer changed their mind");
  const cancelled = await client.waitForClose(waiting);
  expect(cancelled.status === "CANCELLED", "the run ended cancelled");
  expect(
    gateway.reservations().get("res-order-5") === "RELEASED",
    "the compensation released the hold",
  );

  const held = [...gateway.reservations().values()].filter((state) => state === "HELD");
  expect(held.length === 0, "no hold is left behind");
  return problems.length === 0 ? { ok: true } : { ok: false, problem: problems.join("; ") };
}
