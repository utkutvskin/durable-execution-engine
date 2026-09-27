import { describe, expect, it } from "vitest";
import { createJsonCodec, jsonCodec } from "./codec.js";
import { PayloadTooLargeError } from "./errors.js";

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

  it("throws PayloadTooLargeError for a payload over the default 1 MiB limit", () => {
    const value = { blob: "x".repeat(1_048_577) };
    expect(() => jsonCodec.encode(value)).toThrow(PayloadTooLargeError);
  });
});

describe("createJsonCodec", () => {
  it("honors a custom maxPayloadBytes", () => {
    const codec = createJsonCodec({ maxPayloadBytes: 16 });
    expect(() => codec.encode({ a: 1, b: 2, c: 3 })).toThrow(PayloadTooLargeError);
  });

  it("reports the actual byte length and the limit on PayloadTooLargeError", () => {
    const codec = createJsonCodec({ maxPayloadBytes: 10 });
    const json = JSON.stringify({ value: "way over the ten byte limit" });

    try {
      codec.encode({ value: "way over the ten byte limit" });
      expect.unreachable("expected encode to throw PayloadTooLargeError");
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadTooLargeError);
      expect((error as PayloadTooLargeError).maxPayloadBytes).toBe(10);
      expect((error as PayloadTooLargeError).byteLength).toBe(Buffer.byteLength(json, "utf8"));
    }
  });

  it("runs the compress hook on encode and the decompress hook on decode", () => {
    const codec = createJsonCodec({
      compress: (json) => Buffer.from(json, "utf8").toString("base64"),
      decompress: (wire) => Buffer.from(wire, "base64").toString("utf8"),
    });

    const value = { orderId: "order-1" };
    const encoded = codec.encode(value);

    expect(() => {
      JSON.parse(encoded);
    }).toThrow();
    expect(codec.decode(encoded)).toEqual(value);
  });

  it("measures the payload limit after compression, not before", () => {
    const codec = createJsonCodec({
      maxPayloadBytes: 5,
      compress: () => "ok",
    });

    expect(() =>
      codec.encode({ this: "would be far over five bytes as plain json" }),
    ).not.toThrow();
  });

  it("redacts a sensitive field's value everywhere it appears, including nested and in arrays", () => {
    const codec = createJsonCodec({ sensitiveFields: ["ssn"] });
    const value = {
      customer: { name: "ada", ssn: "123-45-6789" },
      dependents: [{ name: "bob", ssn: "111-22-3333" }],
    };

    const roundTripped = codec.decode(codec.encode(value));

    expect(roundTripped).toEqual({
      customer: { name: "ada", ssn: "[redacted]" },
      dependents: [{ name: "bob", ssn: "[redacted]" }],
    });
  });

  it("does not mask anything when sensitiveFields is left empty", () => {
    const codec = createJsonCodec();
    const value = { ssn: "123-45-6789" };
    expect(codec.decode(codec.encode(value))).toEqual(value);
  });
});
