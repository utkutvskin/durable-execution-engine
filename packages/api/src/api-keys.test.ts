import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.js";
import { createApiKeyStore, type ApiKeyStore } from "./api-keys.js";

describe("api key store", () => {
  let database: IsolatedSchema;
  let store: ApiKeyStore;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createApiKeyStore(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  it("authenticates an issued key to its namespace", async () => {
    const issued = await store.issue("acme", "ci");
    const identity = await store.authenticate(issued.key);
    expect(identity).toEqual({
      keyId: issued.keyId,
      namespaceId: issued.namespaceId,
      namespace: "acme",
    });
  });

  it("stores only a hash of the key", async () => {
    const issued = await store.issue("hashing");
    const stored = await database.pool.query<{ key_hash: string }>(
      "select key_hash from api_keys where id = $1",
      [issued.keyId],
    );
    expect(stored.rows[0]?.key_hash).not.toContain(issued.key);
    expect(stored.rows[0]?.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects unknown keys and keys without the expected prefix", async () => {
    await store.issue("known");
    expect(await store.authenticate("dee_unknown")).toBeUndefined();
    expect(await store.authenticate("plain-secret")).toBeUndefined();
    expect(await store.authenticate("")).toBeUndefined();
  });

  it("stops authenticating a key once it is revoked", async () => {
    const issued = await store.issue("revoking");
    expect(await store.revoke(issued.keyId)).toBe(true);
    expect(await store.authenticate(issued.key)).toBeUndefined();
    expect(await store.revoke(issued.keyId)).toBe(false);
  });

  it("gives two keys of one namespace the same namespace id", async () => {
    const first = await store.issue("shared");
    const second = await store.issue("shared");
    expect(first.key).not.toBe(second.key);
    expect(first.namespaceId).toBe(second.namespaceId);
  });

  it("keeps namespaces apart", async () => {
    const left = await store.issue("left");
    const right = await store.issue("right");
    expect(left.namespaceId).not.toBe(right.namespaceId);
    expect((await store.authenticate(left.key))?.namespace).toBe("left");
  });
});
