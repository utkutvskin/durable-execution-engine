import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PayloadTooLargeError } from "./errors.js";
import {
  createGzipCodec,
  createSizeLimitedCodec,
  jsonCodec,
  maskSensitiveFields,
} from "./codec.js";

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

describe("createSizeLimitedCodec", () => {
  it("encodes a payload under the limit unchanged", () => {
    const codec = createSizeLimitedCodec(jsonCodec, 1_024);
    const value = { orderId: "order-1" };

    expect(codec.encode(value)).toBe(jsonCodec.encode(value));
  });

  it("throws PayloadTooLargeError once the encoded payload exceeds the limit", () => {
    const codec = createSizeLimitedCodec(jsonCodec, 1_024);
    const value = { blob: "x".repeat(2_000) };

    expect(() => codec.encode(value)).toThrow(PayloadTooLargeError);
  });

  it("reports the actual and the configured byte count on the error", () => {
    const codec = createSizeLimitedCodec(jsonCodec, 1_024);
    const value = { blob: "x".repeat(2_000) };

    let caught: unknown;
    try {
      codec.encode(value);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    if (caught instanceof PayloadTooLargeError) {
      expect(caught.maxBytes).toBe(1_024);
      expect(caught.actualBytes).toBeGreaterThan(1_024);
    }
  });

  it("defaults to a 1 MiB limit and rejects a payload over 1 MB", () => {
    const codec = createSizeLimitedCodec(jsonCodec);
    const value = { blob: "x".repeat(1_100_000) };

    expect(() => codec.encode(value)).toThrow(PayloadTooLargeError);
  });

  it("never rejects on decode, even for a payload that would now exceed a stricter limit", () => {
    const codec = createSizeLimitedCodec(jsonCodec, 1_024);
    const encoded = jsonCodec.encode({ blob: "x".repeat(2_000) });

    expect(() => codec.decode(encoded)).not.toThrow();
  });
});

describe("createGzipCodec", () => {
  it("round-trips a value through encode and decode", () => {
    const codec = createGzipCodec(jsonCodec);
    const value = { type: "run_started", input: { orderId: "123", items: [1, 2, 3] } };

    expect(codec.decode(codec.encode(value))).toEqual(value);
  });

  it("actually compresses the underlying JSON rather than passing it through", () => {
    const codec = createGzipCodec(jsonCodec);
    const value = { blob: "a".repeat(10_000) };

    const compressed = codec.encode(value);

    expect(compressed).not.toBe(jsonCodec.encode(value));
    expect(compressed.length).toBeLessThan(jsonCodec.encode(value).length);
  });

  it("composes with createSizeLimitedCodec to limit the compressed size", () => {
    const codec = createSizeLimitedCodec(createGzipCodec(jsonCodec), 1_024);
    const compressible = { blob: "a".repeat(100_000) };
    const random = { blob: randomBytes(900_000).toString("base64") };

    expect(() => codec.encode(compressible)).not.toThrow();
    expect(() => codec.encode(random)).toThrow(PayloadTooLargeError);
  });
});

describe("maskSensitiveFields", () => {
  it("masks a top-level sensitive key", () => {
    expect(maskSensitiveFields({ cardNumber: "4242", orderId: "order-1" }, ["cardNumber"])).toEqual(
      {
        cardNumber: "[masked]",
        orderId: "order-1",
      },
    );
  });

  it("masks a sensitive key nested inside an array of objects", () => {
    const value = {
      customers: [
        { ssn: "123-45-6789", name: "a" },
        { ssn: "987-65-4321", name: "b" },
      ],
    };

    expect(maskSensitiveFields(value, ["ssn"])).toEqual({
      customers: [
        { ssn: "[masked]", name: "a" },
        { ssn: "[masked]", name: "b" },
      ],
    });
  });

  it("leaves values untouched when no key matches", () => {
    const value = { orderId: "order-1", amount: 42 };

    expect(maskSensitiveFields(value, ["cardNumber"])).toEqual(value);
  });

  it("does not mutate the original value", () => {
    const value = { cardNumber: "4242" };

    maskSensitiveFields(value, ["cardNumber"]);

    expect(value).toEqual({ cardNumber: "4242" });
  });
});
