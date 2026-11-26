import { describe, expect, it } from "vitest";
import { createApiClient } from "./api.js";
import { containsEncodedPayload, decodeForDisplay, UNDECODABLE_PAYLOAD } from "./payloads.js";

const sealed = { $dee_codec: "aes-256-gcm", keyId: "k1", iv: "a", tag: "b", data: "c" };

describe("decodeForDisplay", () => {
  it("finds an encoded payload at any depth", () => {
    expect(containsEncodedPayload({ type: "run_started", input: sealed })).toBe(true);
    expect(containsEncodedPayload([1, { nested: [sealed] }])).toBe(true);
    expect(containsEncodedPayload({ input: { card: "visible" } })).toBe(false);
  });

  it("asks the codec endpoint once for all values when one is encoded", async () => {
    const asked: unknown[][] = [];
    const api = {
      decodePayloads: (payloads: readonly unknown[]) => {
        asked.push([...payloads]);
        return Promise.resolve([{ card: "4111" }, null]);
      },
    };

    expect(await decodeForDisplay(api, [sealed, null])).toEqual([{ card: "4111" }, null]);
    expect(await decodeForDisplay(api, [{ plain: 1 }])).toEqual([{ plain: 1 }]);
    expect(asked).toEqual([[sealed, null]]);
  });

  it("never shows ciphertext when the endpoint refuses", async () => {
    const api = { decodePayloads: () => Promise.reject(new Error("422")) };

    expect(await decodeForDisplay(api, [sealed, "plain"])).toEqual([UNDECODABLE_PAYLOAD, "plain"]);
  });

  it("posts the payloads to the codec endpoint with the key", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const client = createApiClient("dee_key", (input, init) => {
      seen.push({ url: input as string, body: JSON.parse(init?.body as string) });
      return Promise.resolve(
        new Response(JSON.stringify({ payloads: ["decoded"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    expect(await client.decodePayloads([sealed])).toEqual(["decoded"]);
    expect(seen).toEqual([{ url: "/v1/codec/decode", body: { payloads: [sealed] } }]);
  });
});
