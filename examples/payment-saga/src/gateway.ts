/**
 * A card was refused. The saga does not retry it: the customer has to pay
 * another way.
 */
export class CardDeclinedError extends Error {
  constructor(customerId: string) {
    super(`the card of customer ${customerId} was declined`);
    this.name = "CardDeclinedError";
  }
}

/**
 * What the payment provider offers. Every call is idempotent: repeating it
 * for the same order or reservation has no further effect, which is what lets
 * the engine run a step more than once.
 */
export interface PaymentGateway {
  /** Puts a hold of `amountCents` on the customer's card for the order. */
  reserve(request: ReserveRequest): Promise<Reservation>;
  /** Turns the hold into a charge. Throws `CardDeclinedError` when the card is refused. */
  capture(reservationId: string, amountCents: number): Promise<Capture>;
  /** Lifts the hold. Releasing a captured or released reservation does nothing. */
  release(reservationId: string): Promise<void>;
}

/**
 * What `PaymentGateway.reserve` needs.
 */
export interface ReserveRequest {
  readonly orderId: string;
  readonly customerId: string;
  readonly amountCents: number;
}

/**
 * A hold on a card.
 */
export interface Reservation {
  readonly reservationId: string;
}

/**
 * A completed charge.
 */
export interface Capture {
  readonly captureId: string;
}

/**
 * The state of one reservation in the in-memory gateway.
 */
export type ReservationState = "HELD" | "CAPTURED" | "RELEASED";

/**
 * A gateway that keeps everything in memory and can be told how to misbehave,
 * so the saga can be shown and tested without a payment provider.
 * `declineCustomers` lists customers whose capture is refused;
 * `failFirstCaptures` lists customers whose first capture attempt fails with a
 * transient error.
 */
export interface InMemoryGatewayOptions {
  readonly declineCustomers?: readonly string[];
  readonly failFirstCaptures?: readonly string[];
}

/**
 * The in-memory gateway and a view of what it did.
 */
export interface InMemoryGateway extends PaymentGateway {
  /** The state of every reservation by id. */
  reservations(): ReadonlyMap<string, ReservationState>;
  /** How many times `capture` was called for each reservation, failures included. */
  captureCalls(): ReadonlyMap<string, number>;
  /** Makes the next captures of `customerId` succeed or be refused from now on. */
  decline(customerId: string): void;
  /** Forgets everything. */
  reset(): void;
}

/**
 * Creates an `InMemoryGateway`.
 */
export function createInMemoryGateway(options: InMemoryGatewayOptions = {}): InMemoryGateway {
  const declined = new Set(options.declineCustomers ?? []);
  const flaky = new Set(options.failFirstCaptures ?? []);
  const states = new Map<string, ReservationState>();
  const owners = new Map<string, string>();
  const calls = new Map<string, number>();

  return {
    reserve(request) {
      const reservationId = `res-${request.orderId}`;
      if (!states.has(reservationId)) {
        states.set(reservationId, "HELD");
        owners.set(reservationId, request.customerId);
      }
      return Promise.resolve({ reservationId });
    },
    capture(reservationId) {
      const attempt = (calls.get(reservationId) ?? 0) + 1;
      calls.set(reservationId, attempt);
      const customerId = owners.get(reservationId) ?? "unknown";
      if (declined.has(customerId)) {
        return Promise.reject(new CardDeclinedError(customerId));
      }
      if (flaky.has(customerId) && attempt === 1) {
        return Promise.reject(new Error("the payment provider timed out"));
      }
      if (states.get(reservationId) === "RELEASED") {
        return Promise.reject(new Error(`reservation ${reservationId} was released`));
      }
      states.set(reservationId, "CAPTURED");
      return Promise.resolve({ captureId: `cap-${reservationId}` });
    },
    release(reservationId) {
      if (states.get(reservationId) === "HELD") {
        states.set(reservationId, "RELEASED");
      }
      return Promise.resolve();
    },
    reservations: () => new Map(states),
    captureCalls: () => new Map(calls),
    decline(customerId) {
      declined.add(customerId);
    },
    reset() {
      states.clear();
      owners.clear();
      calls.clear();
    },
  };
}
