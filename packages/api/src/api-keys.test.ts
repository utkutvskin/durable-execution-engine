import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { InvalidApiKeyError, createApiKeyStore, type ApiKeyStore } from "./api-keys.ts";

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

  it("adopts an operator chosen key and authenticates it", async () => {
    const key = "dee_operator-chosen-key-0001";
    const adopted = await store.adopt("adopted", key, "from env");
    expect(adopted.namespace).toBe("adopted");
    expect((await store.authenticate(key))?.keyId).toBe(adopted.keyId);
  });

  it("adopts the same key twice without creating a second row", async () => {
    const key = "dee_operator-chosen-key-0002";
    const first = await store.adopt("twice", key);
    const second = await store.adopt("twice", key);
    expect(second.keyId).toBe(first.keyId);
    const rows = await database.pool.query("select 1 from api_keys where namespace_id = $1", [
      first.namespaceId,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it("refuses to adopt a malformed, revoked or foreign key", async () => {
    await expect(store.adopt("bad", "short")).rejects.toBeInstanceOf(InvalidApiKeyError);
    await expect(store.adopt("bad", "nope_operator-chosen-key-0003")).rejects.toBeInstanceOf(
      InvalidApiKeyError,
    );
    await expect(store.adopt("bad", "dee_has a space inside it!!")).rejects.toBeInstanceOf(
      InvalidApiKeyError,
    );
    const revoked = await store.adopt("revoked-ns", "dee_operator-chosen-key-0004");
    await store.revoke(revoked.keyId);
    await expect(store.adopt("revoked-ns", "dee_operator-chosen-key-0004")).rejects.toThrow(
      /revoked/,
    );
    await expect(store.adopt("other-ns", "dee_operator-chosen-key-0004")).rejects.toThrow(
      /revoked|another namespace/,
    );
  });

  it("tells whether a namespace has a key that is not revoked", async () => {
    expect(await store.hasActiveKey("no-keys-yet")).toBe(false);
    const issued = await store.issue("has-keys");
    expect(await store.hasActiveKey("has-keys")).toBe(true);
    await store.revoke(issued.keyId);
    expect(await store.hasActiveKey("has-keys")).toBe(false);
  });
});
