import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEncryptionCodec, type PayloadCodec } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { createApiKeyStore } from "./api-keys.ts";
import { createApiServer } from "./server.ts";
import { issueTestKey } from "./test-keys.ts";

describe("codec endpoint", () => {
  let database: IsolatedSchema;
  let server: Server;
  let base: string;
  let readKey: string;
  let codec: PayloadCodec;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    codec = createEncryptionCodec({
      keys: [{ id: "k1", key: randomBytes(32) }],
      activeKeyId: "k1",
    });
    const keys = createApiKeyStore(database.pool);
    readKey = (await issueTestKey(keys, "default", { scope: "read" })).key;
    const operateKey = (await issueTestKey(keys, "default", { scope: "operate" })).key;
    ({ server } = createApiServer(database.pool, {
      queueName: "default",
      apiKeys: keys,
      payloadCodec: codec,
      maskFields: ["cvv"],
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const started = await post("/v1/runs", operateKey, {
      workflowType: "order",
      input: { card: "4111", cvv: "123" },
    });
    runId = ((await started.json()) as { run: { runId: string } }).run.runId;
  });

  let runId: string;

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await database.close();
  });

  function post(path: string, key: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "post",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns the stored, encrypted input from a run read and decodes it on request", async () => {
    const described = await fetch(`${base}/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${readKey}` },
    });
    const run = (await described.json()) as { input: unknown };

    expect(JSON.stringify(run.input)).not.toContain("4111");
    const decoded = await post("/v1/codec/decode", readKey, { payloads: [run.input, 7] });
    expect(decoded.status).toBe(200);
    expect(await decoded.json()).toEqual({ payloads: [{ card: "4111", cvv: "[masked]" }, 7] });
  });

  it("decodes the payloads nested in history events and masks them too", async () => {
    const history = await fetch(`${base}/v1/runs/${runId}/history`, {
      headers: { authorization: `Bearer ${readKey}` },
    });
    const { events } = (await history.json()) as { events: { event: unknown }[] };

    const decoded = await post("/v1/codec/decode", readKey, {
      payloads: events.map((entry) => entry.event),
    });

    expect(await decoded.json()).toEqual({
      payloads: [
        expect.objectContaining({
          type: "run_started",
          input: { card: "4111", cvv: "[masked]" },
        }),
      ],
    });
  });

  it("encodes payloads that the decode endpoint reads back", async () => {
    const encoded = await post("/v1/codec/encode", readKey, { payloads: ["secret"] });
    const body = (await encoded.json()) as { payloads: unknown[] };

    expect(body.payloads[0]).toMatchObject({ $dee_codec: "aes-256-gcm", keyId: "k1" });
    const decoded = await post("/v1/codec/decode", readKey, body);
    expect(await decoded.json()).toEqual({ payloads: ["secret"] });
  });

  it("answers 422 for a payload encrypted with a key the server does not have", async () => {
    const foreign = createEncryptionCodec({
      keys: [{ id: "k9", key: randomBytes(32) }],
      activeKeyId: "k9",
    }).encode("x");

    const response = await post("/v1/codec/decode", readKey, { payloads: [foreign] });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "payload_not_decodable" } });
  });

  it("refuses a request without a key and a batch over the limit", async () => {
    const anonymous = await fetch(`${base}/v1/codec/decode`, {
      method: "post",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payloads: [] }),
    });
    const tooMany = await post("/v1/codec/decode", readKey, {
      payloads: Array.from({ length: 1001 }, () => 1),
    });

    expect(anonymous.status).toBe(401);
    expect(tooMany.status).toBe(400);
  });
});
