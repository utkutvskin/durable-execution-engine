import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The key that marks a stored value as an encoded payload. An encoded payload
 * is a JSON object, so it fits every `jsonb` column a payload is stored in.
 */
export const PAYLOAD_ENVELOPE_KEY = "$dee_codec";

/**
 * A payload as a `PayloadCodec` stored it: `$dee_codec` names the codec that
 * wrote it, the other fields are that codec's own.
 */
export interface EncodedPayload {
  /** The id of the codec that wrote the payload, for example `aes-256-gcm`. */
  readonly [PAYLOAD_ENVELOPE_KEY]: string;
  /** The codec's own fields, each a string such as base64 data or a key id. */
  readonly [field: string]: string;
}

/**
 * Converts a user payload (a run input or result, a step input or result, a
 * signal, update or event payload) to the JSON value that is stored, and
 * back. `decode` returns a value that is not an envelope of this codec
 * unchanged, so payloads written before the codec was turned on, and plain
 * payloads, stay readable. Both directions are synchronous so the decision
 * loop can apply them without awaiting.
 */
export interface PayloadCodec {
  /** Returns the value to store for `value`; `undefined` stays `undefined`. */
  encode(value: unknown): unknown;
  /** Returns the payload `stored` holds, or `stored` itself when it is not this codec's envelope. */
  decode(stored: unknown): unknown;
}

/**
 * Whether `value` is an envelope some `PayloadCodec` wrote.
 */
export function isEncodedPayload(value: unknown): value is EncodedPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const marker = (value as Record<string, unknown>)[PAYLOAD_ENVELOPE_KEY];
  return typeof marker === "string";
}

function envelopeOf(value: unknown, codecId: string): EncodedPayload | undefined {
  return isEncodedPayload(value) && value[PAYLOAD_ENVELOPE_KEY] === codecId ? value : undefined;
}

function fieldOf(envelope: EncodedPayload, field: string): string {
  const value = envelope[field];
  if (typeof value !== "string") {
    throw new PayloadDecodeError(
      `encoded payload of codec "${envelope[PAYLOAD_ENVELOPE_KEY]}" has no "${field}" field`,
    );
  }
  return value;
}

/**
 * Thrown when a stored payload is an envelope this codec should read but
 * cannot: a field is missing, the key it names is unknown, or the
 * authentication tag does not match.
 */
export class PayloadDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PayloadDecodeError";
  }
}

/**
 * The codec that stores payloads as they are. It is what runs without a
 * configured codec.
 */
export const identityPayloadCodec: PayloadCodec = {
  encode: (value: unknown): unknown => value,
  decode: (stored: unknown): unknown => stored,
};

/**
 * The `$dee_codec` value of a gzip envelope.
 */
export const GZIP_CODEC_ID = "gzip";

/**
 * A codec that gzip-compresses the JSON form of a payload into
 * `{"$dee_codec": "gzip", "data": <base64>}`. `undefined` is not a payload
 * and passes through.
 */
export function createGzipPayloadCodec(): PayloadCodec {
  return {
    encode(value: unknown): unknown {
      if (value === undefined) {
        return value;
      }
      const data = gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");
      return { [PAYLOAD_ENVELOPE_KEY]: GZIP_CODEC_ID, data };
    },
    decode(stored: unknown): unknown {
      const envelope = envelopeOf(stored, GZIP_CODEC_ID);
      if (envelope === undefined) {
        return stored;
      }
      const json = gunzipSync(Buffer.from(fieldOf(envelope, "data"), "base64")).toString("utf8");
      return JSON.parse(json) as unknown;
    },
  };
}

/**
 * The `$dee_codec` value of an AES-256-GCM envelope.
 */
export const ENCRYPTION_CODEC_ID = "aes-256-gcm";

const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * One AES-256 key: `id` is stored in every payload it encrypts, so a payload
 * can be decrypted after the active key changed.
 */
export interface EncryptionKey {
  /** The id stored in every payload this key encrypts. */
  readonly id: string;
  /** The 32 bytes of the AES-256 key. */
  readonly key: Uint8Array;
}

/**
 * The keys of `createEncryptionCodec`: `activeKeyId` encrypts new payloads,
 * every key in `keys` decrypts.
 */
export interface EncryptionCodecOptions {
  /** Every key a stored payload may have been encrypted with. */
  readonly keys: readonly EncryptionKey[];
  /** The id of the key that encrypts new payloads. */
  readonly activeKeyId: string;
}

/**
 * A codec that encrypts the JSON form of a payload with AES-256-GCM
 * (`node:crypto`), with a random 96-bit IV per payload and the key id as
 * additional authenticated data, into
 * `{"$dee_codec": "aes-256-gcm", "keyId", "iv", "tag", "data"}`. Rotating
 * means adding a new key, making it active, and keeping the old ones for
 * the payloads they wrote. Throws `RangeError` for a key that is not 32
 * bytes, a duplicate id or an active id that is not among the keys.
 */
export function createEncryptionCodec(options: EncryptionCodecOptions): PayloadCodec {
  const keys = new Map<string, Uint8Array>();
  for (const entry of options.keys) {
    if (entry.id.length === 0) {
      throw new RangeError("an encryption key id must not be empty");
    }
    if (entry.key.length !== KEY_BYTES) {
      throw new RangeError(
        `encryption key "${entry.id}" must be ${String(KEY_BYTES)} bytes, got ${String(entry.key.length)}`,
      );
    }
    if (keys.has(entry.id)) {
      throw new RangeError(`encryption key "${entry.id}" is given twice`);
    }
    keys.set(entry.id, entry.key);
  }
  const activeKey = keys.get(options.activeKeyId);
  if (activeKey === undefined) {
    throw new RangeError(
      `the active encryption key "${options.activeKeyId}" is not among the keys`,
    );
  }
  const activeKeyId = options.activeKeyId;
  return {
    encode(value: unknown): unknown {
      if (value === undefined) {
        return value;
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", activeKey, iv);
      cipher.setAAD(Buffer.from(activeKeyId, "utf8"));
      const data = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
        cipher.final(),
      ]);
      return {
        [PAYLOAD_ENVELOPE_KEY]: ENCRYPTION_CODEC_ID,
        keyId: activeKeyId,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      };
    },
    decode(stored: unknown): unknown {
      const envelope = envelopeOf(stored, ENCRYPTION_CODEC_ID);
      if (envelope === undefined) {
        return stored;
      }
      const keyId = fieldOf(envelope, "keyId");
      const key = keys.get(keyId);
      if (key === undefined) {
        throw new PayloadDecodeError(
          `payload was encrypted with key "${keyId}", which this codec does not have; add it to the keys to read it`,
        );
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(fieldOf(envelope, "iv"), "base64"),
        );
        decipher.setAAD(Buffer.from(keyId, "utf8"));
        decipher.setAuthTag(Buffer.from(fieldOf(envelope, "tag"), "base64"));
        const json = Buffer.concat([
          decipher.update(Buffer.from(fieldOf(envelope, "data"), "base64")),
          decipher.final(),
        ]).toString("utf8");
        return JSON.parse(json) as unknown;
      } catch (error) {
        if (error instanceof PayloadDecodeError) {
          throw error;
        }
        throw new PayloadDecodeError(
          `payload encrypted with key "${keyId}" failed authentication; it was changed or the key is wrong`,
          { cause: error },
        );
      }
    },
  };
}

/**
 * Chains codecs: `encode` applies them in order, `decode` in reverse, so
 * `composePayloadCodecs(createGzipPayloadCodec(), encryption)` compresses
 * and then encrypts.
 */
export function composePayloadCodecs(...codecs: readonly PayloadCodec[]): PayloadCodec {
  return {
    encode: (value: unknown): unknown =>
      codecs.reduce((current, codec) => codec.encode(current), value),
    decode: (stored: unknown): unknown =>
      codecs.reduceRight((current, codec) => codec.decode(current), stored),
  };
}

/**
 * Reads encryption keys from their configuration form: comma-separated
 * `id:base64key` entries, for example the `DEE_ENCRYPTION_KEYS` variable.
 * Throws `RangeError` for an entry without an id or a key.
 */
export function parseEncryptionKeys(spec: string): EncryptionKey[] {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry, index) => {
      const separator = entry.indexOf(":");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new RangeError(
          `encryption key entry ${String(index + 1)} is not "id:base64key"; the key itself is not shown`,
        );
      }
      return {
        id: entry.slice(0, separator),
        key: Buffer.from(entry.slice(separator + 1), "base64"),
      };
    });
}
