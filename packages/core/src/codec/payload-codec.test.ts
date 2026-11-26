import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.ts";
import { decodeEventPayloads, encodeEventPayloads } from "./event-payloads.ts";
import {
  composePayloadCodecs,
  createEncryptionCodec,
  createGzipPayloadCodec,
  identityPayloadCodec,
  isEncodedPayload,
  parseEncryptionKeys,
  PayloadDecodeError,
} from "./payload-codec.ts";

const first = { id: "k1", key: randomBytes(32) };
const second = { id: "k2", key: randomBytes(32) };

describe("createEncryptionCodec", () => {
  it("round-trips a payload and stores none of its plaintext", () => {
    const codec = createEncryptionCodec({ keys: [first], activeKeyId: "k1" });
    const value = { card: "4111-1111-1111-1111", amount: 42 };

    const stored = codec.encode(value);

    expect(isEncodedPayload(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("4111");
    expect(stored).toMatchObject({ $dee_codec: "aes-256-gcm", keyId: "k1" });
    expect(codec.decode(stored)).toEqual(value);
  });

  it("uses a fresh IV per payload, so equal values encrypt differently", () => {
    const codec = createEncryptionCodec({ keys: [first], activeKeyId: "k1" });

    expect(codec.encode("same")).not.toEqual(codec.encode("same"));
  });

  it("reads payloads of the previous key after the active key was rotated", () => {
    const before = createEncryptionCodec({ keys: [first], activeKeyId: "k1" });
    const old = before.encode({ order: 1 });
    const after = createEncryptionCodec({ keys: [first, second], activeKeyId: "k2" });

    expect(after.decode(old)).toEqual({ order: 1 });
    expect(after.encode({ order: 2 })).toMatchObject({ keyId: "k2" });
  });

  it("names the missing key when a payload's key was dropped", () => {
    const old = createEncryptionCodec({ keys: [first], activeKeyId: "k1" }).encode(1);
    const codec = createEncryptionCodec({ keys: [second], activeKeyId: "k2" });

    expect(() => codec.decode(old)).toThrow(/key "k1", which this codec does not have/);
  });

  it("rejects a tampered ciphertext and a key id swapped into the envelope", () => {
    const codec = createEncryptionCodec({ keys: [first, second], activeKeyId: "k1" });
    const stored = codec.encode({ amount: 42 }) as Record<string, string>;
    const data = Buffer.from(stored["data"] ?? "", "base64");
    data[0] = (data[0] ?? 0) ^ 1;

    expect(() => codec.decode({ ...stored, data: data.toString("base64") })).toThrow(
      PayloadDecodeError,
    );
    expect(() => codec.decode({ ...stored, keyId: "k2" })).toThrow(PayloadDecodeError);
  });

  it("passes plain payloads and undefined through", () => {
    const codec = createEncryptionCodec({ keys: [first], activeKeyId: "k1" });

    expect(codec.decode({ plain: true })).toEqual({ plain: true });
    expect(codec.encode(undefined)).toBeUndefined();
    expect(codec.decode(codec.encode(null))).toBeNull();
  });

  it("rejects a key of the wrong size, a duplicate id and an unknown active key", () => {
    expect(() =>
      createEncryptionCodec({ keys: [{ id: "k1", key: randomBytes(16) }], activeKeyId: "k1" }),
    ).toThrow(/must be 32 bytes, got 16/);
    expect(() => createEncryptionCodec({ keys: [first, first], activeKeyId: "k1" })).toThrow(
      /given twice/,
    );
    expect(() => createEncryptionCodec({ keys: [first], activeKeyId: "k9" })).toThrow(
      /"k9" is not among the keys/,
    );
  });
});

describe("composePayloadCodecs", () => {
  it("compresses and then encrypts, and reads gzip-only and plain payloads too", () => {
    const gzip = createGzipPayloadCodec();
    const encryption = createEncryptionCodec({ keys: [first], activeKeyId: "k1" });
    const codec = composePayloadCodecs(gzip, encryption);
    const value = { text: "a".repeat(10_000) };

    const stored = codec.encode(value);

    expect(stored).toMatchObject({ $dee_codec: "aes-256-gcm" });
    expect(JSON.stringify(stored).length).toBeLessThan(1000);
    expect(codec.decode(stored)).toEqual(value);
    expect(codec.decode(gzip.encode(value))).toEqual(value);
    expect(codec.decode(value)).toEqual(value);
  });
});

describe("parseEncryptionKeys", () => {
  it("reads id:base64 entries and never echoes a key in its error", () => {
    const spec = `k1:${first.key.toString("base64")}, k2:${second.key.toString("base64")}`;

    expect(parseEncryptionKeys(spec).map((entry) => entry.id)).toEqual(["k1", "k2"]);
    expect(() => parseEncryptionKeys("secretvalue")).toThrow(/entry 1 is not "id:base64key"/);
    expect(() => parseEncryptionKeys("secretvalue")).not.toThrow(/secretvalue/);
  });
});

describe("event payloads", () => {
  it("encodes every user payload of an event and leaves ids, types and errors clear", () => {
    const codec = createEncryptionCodec({ keys: [first], activeKeyId: "k1" });
    const events: WorkflowEvent[] = [
      { type: "run_started", workflowType: "ship", input: { secret: "s1" } },
      { type: "step_scheduled", stepId: "a", stepType: "charge", input: "s2" },
      { type: "step_completed", stepId: "a", result: "s3" },
      { type: "signal_received", signalName: "approve", payload: "s4" },
      {
        type: "run_continued_as_new",
        input: "s5",
        signals: [{ signalName: "approve", payload: "s6" }],
      },
      { type: "run_completed", result: "s7" },
    ];

    const encoded = events.map((event) => encodeEventPayloads(codec, event));
    const text = JSON.stringify(encoded);

    for (const secret of ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]) {
      expect(text).not.toContain(`"${secret}"`);
    }
    expect(encoded[1]).toMatchObject({ stepId: "a", stepType: "charge" });
    expect(encoded.map((event) => decodeEventPayloads(codec, event))).toEqual(events);
  });

  it("changes nothing with the identity codec", () => {
    const event: WorkflowEvent = { type: "step_completed", stepId: "a", result: { ok: 1 } };

    expect(encodeEventPayloads(identityPayloadCodec, event)).toEqual(event);
  });
});
