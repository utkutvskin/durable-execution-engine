import { createQuotaStore, type NamespaceQuota, type NamespaceUsage, type Pool } from "@dee/core";
import type {
  ApiKeyDescription,
  ApiKeyScope,
  ApiKeyStore,
  IssuedApiKey,
  NamespaceSummary,
} from "./api-keys.ts";
import { createAuditLog, type AuditEntry, type AuditLog, type AuditQuery } from "./audit-log.ts";

/**
 * Raised when an administrator names a key that does not exist or was
 * revoked already.
 */
export class ApiKeyNotFoundError extends Error {
  constructor(keyId: string) {
    super(`api key ${keyId} not found or revoked already`);
    this.name = "ApiKeyNotFoundError";
  }
}

/**
 * A namespace as the admin api shows it.
 */
export interface NamespaceView {
  readonly namespaceId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly activeKeys: number;
}

/**
 * An api key as the admin api shows it, without its secret.
 */
export interface ApiKeyView {
  readonly keyId: string;
  readonly namespace: string;
  readonly label: string;
  readonly scope: ApiKeyScope;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * A freshly issued key: the only answer that carries the secret.
 */
export interface IssuedKeyView {
  readonly key: string;
  readonly keyId: string;
  readonly namespace: string;
  readonly label: string;
  readonly scope: ApiKeyScope;
  readonly expiresAt: string | null;
}

/**
 * A namespace's quota with its current usage.
 */
export interface QuotaView {
  readonly namespace: string;
  readonly quota: NamespaceQuota;
  readonly usage: NamespaceUsage;
}

/**
 * An audit log entry as the admin api shows it.
 */
export interface AuditEntryView {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: {
    readonly keyId: string;
    readonly label: string;
    readonly namespace: string;
    readonly scope: ApiKeyScope;
  };
  readonly namespace: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * The admin operations: namespaces, keys, quotas and the audit log. They
 * act across namespaces, so only `admin` keys reach them.
 */
export interface AdminService {
  listNamespaces(): Promise<readonly NamespaceView[]>;

  /** Creates a namespace. Resolves whether this call created it. */
  createNamespace(
    name: string,
  ): Promise<{ readonly namespace: NamespaceView; readonly created: boolean }>;

  /** Issues a key. Rejects with `NamespaceNotFoundError` or `InvalidApiKeyError`. */
  issueKey(
    namespace: string,
    options: { readonly scope: ApiKeyScope; readonly label?: string; readonly expiresAt?: Date },
  ): Promise<IssuedKeyView>;

  /** Lists a namespace's keys. Rejects with `NamespaceNotFoundError`. */
  listKeys(namespace: string): Promise<readonly ApiKeyView[]>;

  /** Revokes a key. Rejects with `ApiKeyNotFoundError`. */
  revokeKey(keyId: string): Promise<ApiKeyView>;

  /** Reads a namespace's quota and usage. Rejects with `NamespaceNotFoundError`. */
  getQuota(namespace: string): Promise<QuotaView>;

  /**
   * Changes the limits named in `changes`; `null` removes a limit and an
   * omitted limit keeps its value. Rejects with `NamespaceNotFoundError`.
   */
  setQuota(namespace: string, changes: Partial<NamespaceQuota>): Promise<QuotaView>;

  /** Reads the audit log, newest first. */
  listAuditLog(query: AuditQuery): Promise<readonly AuditEntryView[]>;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function namespaceView(summary: NamespaceSummary): NamespaceView {
  return {
    namespaceId: summary.namespaceId,
    name: summary.name,
    createdAt: summary.createdAt.toISOString(),
    activeKeys: summary.activeKeys,
  };
}

function keyView(key: ApiKeyDescription): ApiKeyView {
  return {
    keyId: key.keyId,
    namespace: key.namespace,
    label: key.label,
    scope: key.scope,
    createdAt: key.createdAt.toISOString(),
    expiresAt: iso(key.expiresAt),
    lastUsedAt: iso(key.lastUsedAt),
    revokedAt: iso(key.revokedAt),
  };
}

function issuedView(issued: IssuedApiKey): IssuedKeyView {
  return {
    key: issued.key,
    keyId: issued.keyId,
    namespace: issued.namespace,
    label: issued.label,
    scope: issued.scope,
    expiresAt: iso(issued.expiresAt),
  };
}

function auditView(entry: AuditEntry): AuditEntryView {
  return {
    id: entry.id,
    occurredAt: entry.occurredAt.toISOString(),
    actor: {
      keyId: entry.actorKeyId,
      label: entry.actorLabel,
      namespace: entry.actorNamespace,
      scope: entry.actorScope,
    },
    namespace: entry.namespace,
    action: entry.action,
    target: entry.target,
    details: entry.details,
  };
}

/**
 * Creates the `AdminService` over `pool` and the key store the api
 * authenticates with.
 */
export function createAdminService(
  pool: Pool,
  apiKeys: ApiKeyStore,
  auditLog: AuditLog = createAuditLog(pool),
): AdminService {
  const quotas = createQuotaStore(pool);

  async function quotaView(namespace: string, namespaceId: string): Promise<QuotaView> {
    const [quota, usage] = await Promise.all([quotas.get(namespaceId), quotas.usage(namespaceId)]);
    return { namespace, quota, usage };
  }

  async function findNamespace(name: string): Promise<NamespaceView> {
    const all = await apiKeys.listNamespaces();
    const found = all.find((summary) => summary.name === name);
    if (found === undefined) {
      throw new Error(`namespace "${name}" disappeared while it was read`);
    }
    return namespaceView(found);
  }

  return {
    async listNamespaces() {
      return (await apiKeys.listNamespaces()).map(namespaceView);
    },

    async createNamespace(name) {
      const { created } = await apiKeys.createNamespace(name);
      return { namespace: await findNamespace(name), created };
    },

    async issueKey(namespace, options) {
      return issuedView(
        await apiKeys.issue(namespace, {
          scope: options.scope,
          ...(options.label === undefined ? {} : { label: options.label }),
          ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
        }),
      );
    },

    async listKeys(namespace) {
      return (await apiKeys.listKeys(namespace)).map(keyView);
    },

    async revokeKey(keyId) {
      if (!(await apiKeys.revoke(keyId))) {
        throw new ApiKeyNotFoundError(keyId);
      }
      const key = await apiKeys.describeKey(keyId);
      if (key === undefined) {
        throw new ApiKeyNotFoundError(keyId);
      }
      return keyView(key);
    },

    async getQuota(namespace) {
      return quotaView(namespace, await apiKeys.namespaceId(namespace));
    },

    async setQuota(namespace, changes) {
      const namespaceId = await apiKeys.namespaceId(namespace);
      const current = await quotas.get(namespaceId);
      await quotas.set(namespaceId, { ...current, ...changes });
      return quotaView(namespace, namespaceId);
    },

    async listAuditLog(query) {
      return (await auditLog.list(query)).map(auditView);
    },
  };
}
