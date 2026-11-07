import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "@dee/core";

/**
 * The namespace an authenticated api key belongs to.
 */
export interface AuthenticatedNamespace {
  readonly namespaceId: string;
  readonly namespace: string;
  readonly keyId: string;
}

/**
 * A freshly issued api key. `key` is the only time the plain secret exists:
 * the database keeps its hash.
 */
export interface IssuedApiKey extends AuthenticatedNamespace {
  readonly key: string;
}

/**
 * Creates namespaces and issues, checks and revokes the api keys that grant
 * access to them.
 */
export interface ApiKeyStore {
  /**
   * Returns the id of the namespace called `name`, creating it when it does
   * not exist yet.
   */
  ensureNamespace(name: string): Promise<string>;

  /**
   * Issues a new key for the namespace called `namespace`, creating the
   * namespace when needed. The returned `key` is shown once.
   */
  issue(namespace: string, label?: string): Promise<IssuedApiKey>;

  /**
   * Registers a key chosen by the operator (for example one read from the
   * environment) for the namespace called `namespace`, creating the
   * namespace when needed. Registering the same key again changes nothing.
   * Throws when the key is not well formed, or when it was revoked or
   * belongs to another namespace.
   */
  adopt(namespace: string, key: string, label?: string): Promise<AuthenticatedNamespace>;

  /**
   * Whether the namespace called `namespace` has at least one key that is
   * not revoked.
   */
  hasActiveKey(namespace: string): Promise<boolean>;

  /**
   * Resolves a presented key to its namespace. Unknown and revoked keys
   * resolve to `undefined`.
   */
  authenticate(key: string): Promise<AuthenticatedNamespace | undefined>;

  /**
   * Revokes a key by id. Returns false when the key does not exist or was
   * revoked already.
   */
  revoke(keyId: string): Promise<boolean>;
}

const KEY_PREFIX = "dee_";
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 200;

/**
 * Raised by `ApiKeyStore.adopt` for a key that cannot be registered.
 */
export class InvalidApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiKeyError";
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Creates an `ApiKeyStore` over `pool`. Keys are random 192 bit secrets
 * stored as sha256 hashes, so a leaked database does not leak usable keys.
 */
export function createApiKeyStore(pool: Pool): ApiKeyStore {
  async function ensureNamespace(name: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `insert into namespaces (name) values ($1)
       on conflict (name) do update set name = excluded.name
       returning id`,
      [name],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`namespace "${name}" could not be created`);
    }
    return row.id;
  }

  return {
    ensureNamespace,

    async issue(namespace: string, label = ""): Promise<IssuedApiKey> {
      const namespaceId = await ensureNamespace(namespace);
      const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
      const result = await pool.query<{ id: string }>(
        `insert into api_keys (namespace_id, key_hash, label) values ($1, $2, $3) returning id`,
        [namespaceId, hashKey(key), label],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("api key could not be stored");
      }
      return { key, keyId: row.id, namespaceId, namespace };
    },

    async adopt(namespace: string, key: string, label = ""): Promise<AuthenticatedNamespace> {
      if (
        !key.startsWith(KEY_PREFIX) ||
        key.length < MIN_KEY_LENGTH ||
        key.length > MAX_KEY_LENGTH ||
        !/^[\w-]+$/.test(key)
      ) {
        throw new InvalidApiKeyError(
          `an api key starts with ${KEY_PREFIX}, has ${String(MIN_KEY_LENGTH)} to ${String(MAX_KEY_LENGTH)} characters and holds only letters, digits, - and _`,
        );
      }
      const namespaceId = await ensureNamespace(namespace);
      await pool.query(
        `insert into api_keys (namespace_id, key_hash, label) values ($1, $2, $3)
         on conflict (key_hash) do nothing`,
        [namespaceId, hashKey(key), label],
      );
      const result = await pool.query<{ id: string; namespace_id: string; revoked: boolean }>(
        `select id, namespace_id, revoked_at is not null as revoked
         from api_keys where key_hash = $1`,
        [hashKey(key)],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("api key could not be stored");
      }
      if (row.revoked) {
        throw new InvalidApiKeyError("this api key was revoked, choose another one");
      }
      if (row.namespace_id !== namespaceId) {
        throw new InvalidApiKeyError(
          `this api key belongs to another namespace than "${namespace}"`,
        );
      }
      return { keyId: row.id, namespaceId, namespace };
    },

    async hasActiveKey(namespace: string): Promise<boolean> {
      const result = await pool.query(
        `select 1 from api_keys k join namespaces n on n.id = k.namespace_id
         where n.name = $1 and k.revoked_at is null limit 1`,
        [namespace],
      );
      return result.rowCount === 1;
    },

    async authenticate(key: string): Promise<AuthenticatedNamespace | undefined> {
      if (!key.startsWith(KEY_PREFIX)) {
        return undefined;
      }
      const result = await pool.query<{ id: string; namespace_id: string; name: string }>(
        `select k.id, k.namespace_id, n.name
         from api_keys k join namespaces n on n.id = k.namespace_id
         where k.key_hash = $1 and k.revoked_at is null`,
        [hashKey(key)],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return undefined;
      }
      return { keyId: row.id, namespaceId: row.namespace_id, namespace: row.name };
    },

    async revoke(keyId: string): Promise<boolean> {
      const result = await pool.query(
        "update api_keys set revoked_at = now() where id = $1 and revoked_at is null",
        [keyId],
      );
      return result.rowCount === 1;
    },
  };
}
