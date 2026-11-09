import { describe, expect, it } from "vitest";
import { deserializeError, serializeError } from "./error-serialization.ts";

class CardDeclinedError extends Error {
  readonly cardId: string;

  constructor(message: string, cardId: string) {
    super(message);
    this.name = "CardDeclinedError";
    this.cardId = cardId;
  }
}

describe("serializeError", () => {
  it("captures a custom error class's name, message and stack", () => {
    const error = new CardDeclinedError("card declined", "card-1");

    const serialized = serializeError(error);

    expect(serialized.name).toBe("CardDeclinedError");
    expect(serialized.message).toBe("card declined");
    expect(serialized.stack).toBe(error.stack);
  });

  it("normalizes a thrown string to an Error-shaped record", () => {
    expect(serializeError("boom")).toEqual({ name: "Error", message: "boom" });
  });

  it("normalizes a thrown non-error value to an Error-shaped record", () => {
    expect(serializeError({ code: 42 })).toEqual({ name: "Error", message: '{"code":42}' });
  });
});

describe("deserializeError", () => {
  it("reads a custom error class's type and message back", () => {
    const original = new CardDeclinedError("card declined", "card-1");

    const reconstructed = deserializeError(serializeError(original));

    expect(reconstructed.name).toBe("CardDeclinedError");
    expect(reconstructed.message).toBe("card declined");
  });

  it("restores the original stack rather than a freshly captured one", () => {
    const original = new CardDeclinedError("card declined", "card-1");

    const reconstructed = deserializeError(serializeError(original));

    expect(reconstructed.stack).toBe(original.stack);
  });

  it("keeps its own freshly captured stack when none was serialized", () => {
    const reconstructed = deserializeError({ name: "Error", message: "boom" });

    expect(reconstructed.name).toBe("Error");
    expect(reconstructed.message).toBe("boom");
    expect(typeof reconstructed.stack).toBe("string");
  });
});

describe("error details and causes", () => {
  it("keeps the serializable own properties of a custom error as details", () => {
    const serialized = serializeError(new CardDeclinedError("declined", "card-9"));

    expect(serialized.details).toEqual({ cardId: "card-9" });
  });

  it("drops properties that cannot be serialized and omits empty details", () => {
    const error = Object.assign(new Error("odd"), { handler: () => 1, big: 10n });

    expect(serializeError(error)).not.toHaveProperty("details");
  });

  it("serializes the cause chain and rebuilds it", () => {
    const root = new Error("socket closed");
    const middle = new Error("request failed", { cause: root });
    const top = new CardDeclinedError("declined", "card-1");
    top.cause = middle;

    const rebuilt = deserializeError(serializeError(top));

    expect(rebuilt.cause).toMatchObject({ message: "request failed" });
    expect((rebuilt.cause as Error).cause).toMatchObject({ message: "socket closed" });
    expect((rebuilt as unknown as { details: unknown }).details).toEqual({ cardId: "card-1" });
  });

  it("stops following a cause chain after five links", () => {
    let error = new Error("link-0");
    for (let index = 1; index < 10; index += 1) {
      error = new Error(`link-${String(index)}`, { cause: error });
    }

    let depth = 0;
    for (let link = serializeError(error).cause; link !== undefined; link = link.cause) {
      depth += 1;
    }

    expect(depth).toBe(5);
  });

  it("describes a non-error cause as a plain error", () => {
    const serialized = serializeError(new Error("outer", { cause: "just a string" }));

    expect(serialized.cause).toEqual({ name: "Error", message: "just a string" });
  });
});
