import { describe, expect, it } from "vitest";
import { deserializeError, serializeError } from "./error-serialization.js";

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
