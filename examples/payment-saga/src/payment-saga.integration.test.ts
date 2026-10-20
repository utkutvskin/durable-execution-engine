import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowModule } from "@dee/cli";
import { createShiftableClock } from "../../../packages/worker/src/chaos/world.js";
import {
  startTestEnvironment,
  type TestEnvironment,
} from "../../../packages/cli/src/test-support.js";
import { createInMemoryGateway, type InMemoryGateway } from "./gateway.js";
import { demo, gateway as demoGateway, steps as demoSteps } from "./index.js";
import { createPaymentSteps } from "./steps.js";
import {
  APPROVAL_THRESHOLD_CENTS,
  PAYMENT_SAGA,
  paymentSaga,
  type PaymentInput,
  type PaymentResult,
} from "./workflow.js";

describe("payment saga", () => {
  let current: TestEnvironment | undefined;

  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  async function boot(
    gateway: InMemoryGateway,
    clock = createShiftableClock(),
  ): Promise<TestEnvironment> {
    const module: WorkflowModule = {
      workflows: [paymentSaga],
      steps: createPaymentSteps(gateway),
    };
    current = await startTestEnvironment(module, { clock });
    return current;
  }

  function order(overrides: Partial<PaymentInput> = {}): PaymentInput {
    return { orderId: "o-1", customerId: "c-1", amountCents: 1_000, ...overrides };
  }

  it("reserves, captures and sends a receipt for a small order", async () => {
    const gateway = createInMemoryGateway();
    const { environment } = await boot(gateway);
    const run = await environment.client.waitForClose(
      await environment.client.start(PAYMENT_SAGA, order()),
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.result).toEqual({
      status: "captured",
      reservationId: "res-o-1",
      captureId: "cap-res-o-1",
      receiptId: "rcpt-o-1",
    } satisfies PaymentResult);
    expect(gateway.reservations().get("res-o-1")).toBe("CAPTURED");
  });

  it("waits for an approval before charging a large order", async () => {
    const gateway = createInMemoryGateway();
    const { environment } = await boot(gateway);
    const runId = await environment.client.start(
      PAYMENT_SAGA,
      order({ amountCents: APPROVAL_THRESHOLD_CENTS }),
    );
    for (let round = 0; round < 100; round += 1) {
      if (gateway.reservations().get("res-o-1") === "HELD") {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect((await environment.client.describe(runId)).status).toBe("RUNNING");
    expect(gateway.captureCalls().size).toBe(0);
    await environment.client.signal(runId, "approval", { approved: true });
    const run = await environment.client.waitForClose(runId);
    expect((run.result as PaymentResult).status).toBe("captured");
  });

  it("releases the hold when the approval is refused", async () => {
    const gateway = createInMemoryGateway();
    const { environment } = await boot(gateway);
    const runId = await environment.client.start(
      PAYMENT_SAGA,
      order({ amountCents: APPROVAL_THRESHOLD_CENTS }),
    );
    await environment.client.signal(runId, "approval", { approved: false });
    const run = await environment.client.waitForClose(runId);
    expect(run.result).toMatchObject({ status: "compensated", reason: "approval refused" });
    expect(gateway.reservations().get("res-o-1")).toBe("RELEASED");
    expect(gateway.captureCalls().size).toBe(0);
  });

  it("releases the hold when nobody approves before the timeout", async () => {
    const gateway = createInMemoryGateway();
    const clock = createShiftableClock();
    const { environment } = await boot(gateway, clock);
    const runId = await environment.client.start(
      PAYMENT_SAGA,
      order({ amountCents: APPROVAL_THRESHOLD_CENTS, approvalTimeoutMs: 3_600_000 }),
    );
    for (let round = 0; round < 100; round += 1) {
      if (gateway.reservations().get("res-o-1") === "HELD") {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    for (let round = 0; round < 200; round += 1) {
      const history = await environment.client.history(runId);
      if (history.some((item) => item.event.type === "timer_started")) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    clock.shift(3_600_001);
    const run = await environment.client.waitForClose(runId);
    expect(run.result).toMatchObject({ status: "compensated", reason: "approval timed out" });
    expect(gateway.reservations().get("res-o-1")).toBe("RELEASED");
  });

  it("does not retry a declined card and compensates at once", async () => {
    const gateway = createInMemoryGateway({ declineCustomers: ["c-1"] });
    const { environment } = await boot(gateway);
    const run = await environment.client.waitForClose(
      await environment.client.start(PAYMENT_SAGA, order()),
    );
    expect(run.result).toMatchObject({ status: "compensated" });
    expect((run.result as { reason: string }).reason).toContain("declined");
    expect(gateway.captureCalls().get("res-o-1")).toBe(1);
    expect(gateway.reservations().get("res-o-1")).toBe("RELEASED");
  });

  it("retries a transient provider failure and still captures once", async () => {
    const gateway = createInMemoryGateway({ failFirstCaptures: ["c-1"] });
    const clock = createShiftableClock();
    const { environment } = await boot(gateway, clock);
    const runId = await environment.client.start(PAYMENT_SAGA, order());
    for (let round = 0; round < 300; round += 1) {
      clock.shift(200);
      if ((await environment.client.describe(runId)).status !== "RUNNING") {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const run = await environment.client.describe(runId);
    expect((run.result as PaymentResult).status).toBe("captured");
    expect(gateway.captureCalls().get("res-o-1")).toBe(2);
    expect(gateway.reservations().get("res-o-1")).toBe("CAPTURED");
  });

  it("releases the hold of a run that is cancelled while it waits", async () => {
    const gateway = createInMemoryGateway();
    const { environment } = await boot(gateway);
    const runId = await environment.client.start(
      PAYMENT_SAGA,
      order({ amountCents: APPROVAL_THRESHOLD_CENTS }),
    );
    for (let round = 0; round < 100; round += 1) {
      if (gateway.reservations().get("res-o-1") === "HELD") {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await environment.client.cancel(runId, "customer changed their mind");
    const run = await environment.client.waitForClose(runId);
    expect(run.status).toBe("CANCELLED");
    expect(gateway.reservations().get("res-o-1")).toBe("RELEASED");
  });

  it("plays the whole demo story with every claim holding", async () => {
    current = await startTestEnvironment({ workflows: [paymentSaga], steps: demoSteps });
    const lines: string[] = [];
    const report = await demo.run({
      client: current.environment.client,
      schedules: current.environment.schedules,
      namespaceId: current.environment.namespaceId,
      log: (line) => lines.push(line),
    });
    expect(report).toEqual({ ok: true });
    expect(lines.filter((line) => line.includes("bad"))).toEqual([]);
    expect([...demoGateway.reservations().values()]).not.toContain("HELD");
  }, 30_000);
});
