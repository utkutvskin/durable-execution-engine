import { describe, expect, it } from "vitest";
import { jsonCodec } from "./codec.js";

describe("jsonCodec", () => {
  it("round-trips a nested object through encode and decode", () => {
    const value = { type: "run_started", input: { orderId: "123", items: [1, 2, 3] } };
    expect(jsonCodec.decode(jsonCodec.encode(value))).toEqual(value);
  });

  it("encodes to a JSON string", () => {
    const encoded = jsonCodec.encode({ a: 1 });
    expect(typeof encoded).toBe("string");
    expect(JSON.parse(encoded)).toEqual({ a: 1 });
  });
});
