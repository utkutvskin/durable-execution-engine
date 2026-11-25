import { createHash, randomBytes } from "node:crypto";
import type { ClockSource, Pool } from "@dee/core";

/**
 * What an api key may do. `read` keys may only read, `operate` keys may also
 * start, signal, cancel, terminate, pause and requeue work in their
 * namespace, and `admin` keys may also manage namespaces, keys, quotas and
 * read the audit log of every namespace.
 */
export type ApiKeyScope = "read" | "operate" | "admin";

/**
 * The scopes from the weakest to the strongest. A scope includes every scope
 * before it.
 */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ["read", "operate", "admin"];

/**
 * Whether a key of scope `held` may call an endpoint that needs `needed`.
 */
export function scopeAllows(held: ApiKeyScope, needed: ApiKeyScope): boolean {
  return API_KEY_SCOPES.indexOf(held) >= API_KEY_SCOPES.indexOf(needed);
}

/**
 * The namespace an authenticated api key belongs to, with the key's scope
 * and label.
 */
export interface AuthenticatedNamespace {
  readonly namespaceId: string;
  readonly namespace: string;
  readonly keyId: string;
  readonly scope: ApiKeyScope;
  readonly label: string;
}

/**
 * A freshly issued api key. `key` is the only time the plain secret exists:
 * the database keeps its hash.
 */
export interface IssuedApiKey extends AuthenticatedNamespace {
  readonly key: string;
  readonly expiresAt: Date | null;
}

/**
 * How a key is issued or adopted. `scope` defaults to `admin`, the access
 * every key had before scopes existed. A key with `expiresAt` is refused
 * from that instant on.
 */
export interface IssueKeyOptions {
  readonly label?: string;
  readonly scope?: ApiKeyScope;
  readonly expiresAt?: Date;
}

/**
 * An api key as an administrator sees it. The secret is never shown again.
 */
export interface ApiKeyDescription {
  readonly keyId: string;
  readonly namespace: string;
  readonly label: string;
  readonly scope: ApiKeyScope;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * A namespace as an administrator sees it. `activeKeys` counts the keys that
 * are neither revoked nor expired.
 */
export interface NamespaceSummary {
  readonly namespaceId: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly activeKeys: number;
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
   * Creates the namespace called `name`. Resolves whether this call created
   * it; a namespace that exists already is returned unchanged.
   */
  createNamespace(
    name: string,
  ): Promise<{ readonly namespaceId: string; readonly created: boolean }>;

  /** Lists every namespace by name. */
  listNamespaces(): Promise<NamespaceSummary[]>;

  /**
   * Resolves the id of the namespace called `name`. Rejects with
   * `NamespaceNotFoundError`.
   */
  namespaceId(name: string): Promise<string>;

  /**
   * Issues a new key for the existing namespace called `namespace`. The
   * returned `key` is shown once. Rejects with `NamespaceNotFoundError`:
   * issuing a key never creates a namespace.
   */
  issue(namespace: string, options?: IssueKeyOptions): Promise<IssuedApiKey>;

  /**
   * Registers a key chosen by the operator (for example one read from the
   * environment) for the existing namespace called `namespace`. Registering
   * the same key again changes nothing. Throws `InvalidApiKeyError` when the
   * key is not well formed, or when it was revoked or belongs to another
   * namespace, and `NamespaceNotFoundError`.
   */
  adopt(namespace: string, key: string, options?: IssueKeyOptions): Promise<AuthenticatedNamespace>;

  /**
   * Whether the namespace called `namespace` has at least one key that is
   * neither revoked nor expired.
   */
  hasActiveKey(namespace: string): Promise<boolean>;

  /**
   * Resolves a presented key to its namespace and records when it was last
   * used, at most once a minute per key. Unknown, revoked and expired keys
   * resolve to `undefined`.
   */
  authenticate(key: string): Promise<AuthenticatedNamespace | undefined>;

  /**
   * Lists the keys of the namespace called `namespace`, oldest first,
   * revoked and expired ones included. Rejects with
   * `NamespaceNotFoundError`.
   */
  listKeys(namespace: string): Promise<ApiKeyDescription[]>;

  /** Reads one key by id, or `undefined` when there is none. */
  describeKey(keyId: string): Promise<ApiKeyDescription | undefined>;

  /**
   * Revokes a key by id. Returns false when the key does not exist or was
   * revoked already.
   */
  revoke(keyId: string): Promise<boolean>;
}

/**
 * Options for `createApiKeyStore`. Without `clock`, expiry and
 * `last_used_at` use the database's time.
 */
export interface ApiKeyStoreOptions {
  readonly clock?: ClockSource;
}

const KEY_PREFIX = "dee_";
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How stale `last_used_at` may get before a request writes it again, so a
 * busy key costs one write a minute instead of one per request.
 */
export const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Raised by `ApiKeyStore.adopt` for a key that cannot be registered, and by
 * `issue` and `adopt` for an expiry that is not in the future.
 */
export class InvalidApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiKeyError";
  }
}

/**
 * Raised when a namespace named by an administrator does not exist.
 */
export class NamespaceNotFoundError extends Error {
  readonly namespace: string;

  constructor(namespace: string) {
    super(`namespace "${namespace}" does not exist; create it with wf namespace create`);
    this.name = "NamespaceNotFoundError";
    this.namespace = namespace;
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

interface KeyRow {
  id: string;
  name: string;
  label: string;
  scope: ApiKeyScope;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function toDescription(row: KeyRow): ApiKeyDescription {
  return {
    keyId: row.id,
    namespace: row.name,
    label: row.label,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

const KEY_COLUMNS = `k.id, n.name, k.label, k.scope, k.created_at, k.expires_at, k.last_used_at,
  k.revoked_at`;

/**
 * Creates an `ApiKeyStore` over `pool`. Keys are random 192 bit secrets
 * stored as sha256 hashes, so a leaked database does not leak usable keys.
 */
export function createApiKeyStore(pool: Pool, options: ApiKeyStoreOptions = {}): ApiKeyStore {
  const instant = (): Date | null => options.clock?.now() ?? null;

  function assertFutureExpiry(expiresAt: Date | undefined): void {
    if (expiresAt === undefined) {
      return;
    }
    const now = options.clock?.now() ?? new Date();
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
      throw new InvalidApiKeyError("a key's expiry must be a valid instant in the future");
    }
  }

  async function ensureNamespace(name: string): Promise<string> {
    return (await createNamespace(name)).namespaceId;
  }

  async function createNamespace(
    name: string,
  ): Promise<{ readonly namespaceId: string; readonly created: boolean }> {
    const result = await pool.query<{ id: string; created: boolean }>(
      `insert into namespaces (name) values ($1)
       on conflict (name) do update set name = excluded.name
       returning id, (xmax = 0) as created`,
      [name],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`namespace "${name}" could not be created`);
    }
    return { namespaceId: row.id, created: row.created };
  }

  async function namespaceId(name: string): Promise<string> {
    const result = await pool.query<{ id: string }>("select id from namespaces where name = $1", [
      name,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new NamespaceNotFoundError(name);
    }
    return row.id;
  }

  return {
    ensureNamespace,
    createNamespace,
    namespaceId,

    async listNamespaces(): Promise<NamespaceSummary[]> {
      const result = await pool.query<{
        id: string;
        name: string;
        created_at: Date;
        active_keys: number;
      }>(
        `select n.id, n.name, n.created_at,
                (select count(*)::int from api_keys k
                 where k.namespace_id = n.id and k.revoked_at is null
                   and (k.expires_at is null or k.expires_at > coalesce($1::timestamptz, now())))
                  as active_keys
         from namespaces n order by n.name`,
        [instant()],
      );
      return result.rows.map((row) => ({
        namespaceId: row.id,
        name: row.name,
        createdAt: row.created_at,
        activeKeys: row.active_keys,
      }));
    },

    async issue(namespace: string, issueOptions: IssueKeyOptions = {}): Promise<IssuedApiKey> {
      assertFutureExpiry(issueOptions.expiresAt);
      const id = await namespaceId(namespace);
      const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
      const scope = issueOptions.scope ?? "admin";
      const label = issueOptions.label ?? "";
      const expiresAt = issueOptions.expiresAt ?? null;
      const result = await pool.query<{ id: string }>(
        `insert into api_keys (namespace_id, key_hash, label, scope, expires_at)
         values ($1, $2, $3, $4, $5) returning id`,
        [id, hashKey(key), label, scope, expiresAt],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("api key could not be stored");
      }
      return { key, keyId: row.id, namespaceId: id, namespace, scope, label, expiresAt };
    },

    async adopt(
      namespace: string,
      key: string,
      adoptOptions: IssueKeyOptions = {},
    ): Promise<AuthenticatedNamespace> {
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
      assertFutureExpiry(adoptOptions.expiresAt);
      const id = await namespaceId(namespace);
      await pool.query(
        `insert into api_keys (namespace_id, key_hash, label, scope, expires_at)
         values ($1, $2, $3, $4, $5)
         on conflict (key_hash) do nothing`,
        [
          id,
          hashKey(key),
          adoptOptions.label ?? "",
          adoptOptions.scope ?? "admin",
          adoptOptions.expiresAt ?? null,
        ],
      );
      const result = await pool.query<{
        id: string;
        namespace_id: string;
        revoked: boolean;
        scope: ApiKeyScope;
        label: string;
      }>(
        `select id, namespace_id, revoked_at is not null as revoked, scope, label
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
      if (row.namespace_id !== id) {
        throw new InvalidApiKeyError(
          `this api key belongs to another namespace than "${namespace}"`,
        );
      }
      return { keyId: row.id, namespaceId: id, namespace, scope: row.scope, label: row.label };
    },

    async hasActiveKey(namespace: string): Promise<boolean> {
      const result = await pool.query(
        `select 1 from api_keys k join namespaces n on n.id = k.namespace_id
         where n.name = $1 and k.revoked_at is null
           and (k.expires_at is null or k.expires_at > coalesce($2::timestamptz, now()))
         limit 1`,
        [namespace, instant()],
      );
      return result.rowCount === 1;
    },

    async authenticate(key: string): Promise<AuthenticatedNamespace | undefined> {
      if (!key.startsWith(KEY_PREFIX)) {
        return undefined;
      }
      const now = instant();
      const result = await pool.query<{
        id: string;
        namespace_id: string;
        name: string;
        scope: ApiKeyScope;
        label: string;
        stale: boolean;
      }>(
        `select k.id, k.namespace_id, n.name, k.scope, k.label,
                (k.last_used_at is null
                  or k.last_used_at < coalesce($2::timestamptz, now()) - $3 * interval '1 millisecond')
                  as stale
         from api_keys k join namespaces n on n.id = k.namespace_id
         where k.key_hash = $1 and k.revoked_at is null
           and (k.expires_at is null or k.expires_at > coalesce($2::timestamptz, now()))`,
        [hashKey(key), now, LAST_USED_RESOLUTION_MS],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return undefined;
      }
      if (row.stale) {
        await pool.query(
          "update api_keys set last_used_at = coalesce($2::timestamptz, now()) where id = $1",
          [row.id, now],
        );
      }
      return {
        keyId: row.id,
        namespaceId: row.namespace_id,
        namespace: row.name,
        scope: row.scope,
        label: row.label,
      };
    },

    async listKeys(namespace: string): Promise<ApiKeyDescription[]> {
      const id = await namespaceId(namespace);
      const result = await pool.query<KeyRow>(
        `select ${KEY_COLUMNS}
         from api_keys k join namespaces n on n.id = k.namespace_id
         where k.namespace_id = $1 order by k.created_at, k.id`,
        [id],
      );
      return result.rows.map(toDescription);
    },

    async describeKey(keyId: string): Promise<ApiKeyDescription | undefined> {
      if (!UUID_PATTERN.test(keyId)) {
        return undefined;
      }
      const result = await pool.query<KeyRow>(
        `select ${KEY_COLUMNS}
         from api_keys k join namespaces n on n.id = k.namespace_id
         where k.id = $1`,
        [keyId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toDescription(row);
    },

    async revoke(keyId: string): Promise<boolean> {
      if (!UUID_PATTERN.test(keyId)) {
        return false;
      }
      const result = await pool.query(
        `update api_keys set revoked_at = coalesce($2::timestamptz, now())
         where id = $1 and revoked_at is null`,
        [keyId, instant()],
      );
      return result.rowCount === 1;
    },
  };
}
