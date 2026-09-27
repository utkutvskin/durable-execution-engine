import { describe, expect, it } from "vitest";
import { deserializeError, serializeError } from "./error-serialization.js";

class CardDeclinedError extends Error {
  readonly cardId: string;

  constructor(cardId: string) {
    super(`card ${cardId} was declined`);
    this.name = "CardDeclinedError";
    this.cardId = cardId;
  }
}

describe("serializeError / deserializeError", () => {
  it("preserves a custom error's type, message and stack across a JSON round trip", () => {
    const original = new CardDeclinedError("card-1");

    const wireForm: unknown = JSON.parse(JSON.stringify(serializeError(original)));
    const restored = deserializeError(wireForm as ReturnType<typeof serializeError>);

    expect(restored).toBeInstanceOf(Error);
    expect(restored.name).toBe("CardDeclinedError");
    expect(restored.message).toBe("card card-1 was declined");
    expect(restored.stack).toBe(original.stack);
  });

  it("preserves a plain Error's type and message", () => {
    const restored = deserializeError(serializeError(new Error("boom")));

    expect(restored.name).toBe("Error");
    expect(restored.message).toBe("boom");
  });

  it("omits stack from the serialized form when the original error has none", () => {
    const error = new Error("boom");
    delete error.stack;

    const serialized = serializeError(error);

    expect(serialized).toEqual({ name: "Error", message: "boom" });
    expect("stack" in serialized).toBe(false);
  });

  it("deserializes without a stack when none was serialized", () => {
    const restored = deserializeError({ name: "Error", message: "boom" });

    expect(restored.name).toBe("Error");
    expect(restored.message).toBe("boom");
  });
});
