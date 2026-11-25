import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import {
  InvalidApiKeyError,
  LAST_USED_RESOLUTION_MS,
  NamespaceNotFoundError,
  createApiKeyStore,
  scopeAllows,
  type ApiKeyStore,
} from "./api-keys.ts";

const NAMESPACES = [
  "acme",
  "hashing",
  "known",
  "revoking",
  "shared",
  "left",
  "right",
  "adopted",
  "twice",
  "bad",
  "revoked-ns",
  "other-ns",
  "no-keys-yet",
  "has-keys",
];

describe("api key store", () => {
  let database: IsolatedSchema;
  let store: ApiKeyStore;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createApiKeyStore(database.pool);
    for (const name of NAMESPACES) {
      await store.ensureNamespace(name);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  it("authenticates an issued key to its namespace", async () => {
    const issued = await store.issue("acme", { label: "ci" });
    const identity = await store.authenticate(issued.key);
    expect(identity).toEqual({
      keyId: issued.keyId,
      namespaceId: issued.namespaceId,
      namespace: "acme",
      scope: "admin",
      label: "ci",
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
    const adopted = await store.adopt("adopted", key, { label: "from env" });
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

  it("refuses to issue or adopt a key for a namespace that does not exist, and creates none", async () => {
    await expect(store.issue("never-created")).rejects.toBeInstanceOf(NamespaceNotFoundError);
    await expect(
      store.adopt("never-created", "dee_operator-chosen-key-0005"),
    ).rejects.toBeInstanceOf(NamespaceNotFoundError);
    const rows = await database.pool.query("select 1 from namespaces where name = 'never-created'");
    expect(rows.rowCount).toBe(0);
  });

  it("creates a namespace once and reports whether this call created it", async () => {
    const first = await store.createNamespace("created-once");
    const second = await store.createNamespace("created-once");
    expect(first.created).toBe(true);
    expect(second).toEqual({ namespaceId: first.namespaceId, created: false });
    const listed = (await store.listNamespaces()).find((ns) => ns.name === "created-once");
    expect(listed).toMatchObject({ namespaceId: first.namespaceId, activeKeys: 0 });
  });

  it("stores the scope a key was issued with", async () => {
    await store.ensureNamespace("scoped");
    const reader = await store.issue("scoped", { scope: "read" });
    const operator = await store.issue("scoped", { scope: "operate" });
    expect((await store.authenticate(reader.key))?.scope).toBe("read");
    expect((await store.authenticate(operator.key))?.scope).toBe("operate");
    expect((await store.listKeys("scoped")).map((key) => key.scope)).toEqual(["read", "operate"]);
  });

  it("orders the scopes read, operate, admin", () => {
    expect(scopeAllows("read", "read")).toBe(true);
    expect(scopeAllows("read", "operate")).toBe(false);
    expect(scopeAllows("operate", "read")).toBe(true);
    expect(scopeAllows("operate", "admin")).toBe(false);
    expect(scopeAllows("admin", "operate")).toBe(true);
  });

  it("stops authenticating a key at its expiry on a fake clock", async () => {
    let now = new Date("2030-01-01T00:00:00Z");
    const clocked = createApiKeyStore(database.pool, { clock: { now: () => now } });
    await clocked.ensureNamespace("expiring");
    const issued = await clocked.issue("expiring", {
      expiresAt: new Date("2030-01-01T01:00:00Z"),
    });
    expect((await clocked.authenticate(issued.key))?.keyId).toBe(issued.keyId);
    expect(await clocked.hasActiveKey("expiring")).toBe(true);
    now = new Date("2030-01-01T01:00:00Z");
    expect(await clocked.authenticate(issued.key)).toBeUndefined();
    expect(await clocked.hasActiveKey("expiring")).toBe(false);
    expect((await clocked.listKeys("expiring"))[0]?.expiresAt).toEqual(
      new Date("2030-01-01T01:00:00Z"),
    );
  });

  it("refuses an expiry that is not in the future", async () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const clocked = createApiKeyStore(database.pool, { clock: { now: () => now } });
    await expect(clocked.issue("acme", { expiresAt: now })).rejects.toBeInstanceOf(
      InvalidApiKeyError,
    );
    await expect(
      clocked.issue("acme", { expiresAt: new Date("not a date") }),
    ).rejects.toBeInstanceOf(InvalidApiKeyError);
  });

  it("records last_used_at at most once per resolution window", async () => {
    let now = new Date("2030-02-01T00:00:00Z");
    const clocked = createApiKeyStore(database.pool, { clock: { now: () => now } });
    await clocked.ensureNamespace("used");
    const issued = await clocked.issue("used");
    const lastUsed = async (): Promise<Date | null | undefined> =>
      (await clocked.describeKey(issued.keyId))?.lastUsedAt;
    expect(await lastUsed()).toBeNull();
    await clocked.authenticate(issued.key);
    expect(await lastUsed()).toEqual(new Date("2030-02-01T00:00:00Z"));
    now = new Date(now.getTime() + LAST_USED_RESOLUTION_MS - 1);
    await clocked.authenticate(issued.key);
    expect(await lastUsed()).toEqual(new Date("2030-02-01T00:00:00Z"));
    now = new Date(now.getTime() + 2);
    await clocked.authenticate(issued.key);
    expect(await lastUsed()).toEqual(now);
  });
});
