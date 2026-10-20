import { describe, expect, it } from "vitest";
import { CardDeclinedError, createInMemoryGateway } from "./gateway.js";

describe("in memory payment gateway", () => {
  const request = { orderId: "o", customerId: "c", amountCents: 100 };

  it("makes reserve idempotent for the same order", async () => {
    const gateway = createInMemoryGateway();
    const first = await gateway.reserve(request);
    const second = await gateway.reserve(request);
    expect(second).toEqual(first);
    expect(gateway.reservations().size).toBe(1);
  });

  it("refuses a captured reservation a release and a released one a capture", async () => {
    const gateway = createInMemoryGateway();
    const { reservationId } = await gateway.reserve(request);
    await gateway.capture(reservationId, 100);
    await gateway.release(reservationId);
    expect(gateway.reservations().get(reservationId)).toBe("CAPTURED");
    const other = await gateway.reserve({ ...request, orderId: "p" });
    await gateway.release(other.reservationId);
    await expect(gateway.capture(other.reservationId, 100)).rejects.toThrow("was released");
  });

  it("declines named customers with a typed error and fails a first capture once", async () => {
    const gateway = createInMemoryGateway({
      declineCustomers: ["bad"],
      failFirstCaptures: ["flaky"],
    });
    const declined = await gateway.reserve({ ...request, orderId: "d", customerId: "bad" });
    await expect(gateway.capture(declined.reservationId, 1)).rejects.toBeInstanceOf(
      CardDeclinedError,
    );
    const flaky = await gateway.reserve({ ...request, orderId: "f", customerId: "flaky" });
    await expect(gateway.capture(flaky.reservationId, 1)).rejects.toThrow("timed out");
    await expect(gateway.capture(flaky.reservationId, 1)).resolves.toEqual({
      captureId: `cap-${flaky.reservationId}`,
    });
    expect(gateway.captureCalls().get(flaky.reservationId)).toBe(2);
  });
});
