import { createApiCall, type ApiClientOptions } from "./run-client.ts";

/**
 * What a key may do: `read`, `operate` or `admin`.
 */
export type KeyScope = "read" | "operate" | "admin";

/**
 * A namespace as the admin api reports it.
 */
export interface NamespaceSnapshot {
  readonly namespaceId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly activeKeys: number;
}

/**
 * An api key as the admin api reports it, without its secret.
 */
export interface KeySnapshot {
  readonly keyId: string;
  readonly namespace: string;
  readonly label: string;
  readonly scope: KeyScope;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * A freshly issued key with its secret, shown once.
 */
export interface IssuedKeySnapshot {
  readonly key: string;
  readonly keyId: string;
  readonly namespace: string;
  readonly label: string;
  readonly scope: KeyScope;
  readonly expiresAt: string | null;
}

/**
 * The limits of a namespace; `null` is no limit.
 */
export interface QuotaLimits {
  readonly maxConcurrentRuns: number | null;
  readonly maxPendingTasks: number | null;
  readonly ratePerSecond: number | null;
  readonly burst: number | null;
}

/**
 * A namespace's quota with what it uses now.
 */
export interface QuotaSnapshot {
  readonly namespace: string;
  readonly quota: QuotaLimits;
  readonly usage: { readonly openRuns: number; readonly pendingTasks: number };
}

/**
 * One audit log entry as the admin api reports it.
 */
export interface AuditSnapshot {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: {
    readonly keyId: string;
    readonly label: string;
    readonly namespace: string;
    readonly scope: KeyScope;
  };
  readonly namespace: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * The admin surface of the api the `wf namespace`, `wf keys`, `wf quota`
 * and `wf audit` commands use. It needs an `admin` key.
 */
export interface AdminClient {
  listNamespaces(): Promise<readonly NamespaceSnapshot[]>;
  createNamespace(
    name: string,
  ): Promise<{ readonly namespace: NamespaceSnapshot; readonly created: boolean }>;
  issueKey(
    namespace: string,
    options: { readonly scope: KeyScope; readonly label?: string; readonly expiresAt?: string },
  ): Promise<IssuedKeySnapshot>;
  listKeys(namespace: string): Promise<readonly KeySnapshot[]>;
  revokeKey(keyId: string): Promise<KeySnapshot>;
  getQuota(namespace: string): Promise<QuotaSnapshot>;
  setQuota(namespace: string, changes: Partial<QuotaLimits>): Promise<QuotaSnapshot>;
  listAudit(filter: {
    readonly namespace?: string;
    readonly limit?: number;
  }): Promise<readonly AuditSnapshot[]>;
}

function namespacePath(namespace: string, suffix: string): string {
  return `/v1/admin/namespaces/${encodeURIComponent(namespace)}${suffix}`;
}

/**
 * Creates an `AdminClient` for the http api at `options.baseUrl`.
 */
export function createAdminClient(options: ApiClientOptions): AdminClient {
  const call = createApiCall(options);

  return {
    async listNamespaces() {
      return ((await call("GET", "/v1/admin/namespaces")) as { namespaces: NamespaceSnapshot[] })
        .namespaces;
    },
    async createNamespace(name) {
      return (await call("POST", "/v1/admin/namespaces", { name })) as {
        namespace: NamespaceSnapshot;
        created: boolean;
      };
    },
    async issueKey(namespace, issue) {
      return (await call("POST", namespacePath(namespace, "/keys"), issue)) as IssuedKeySnapshot;
    },
    async listKeys(namespace) {
      return ((await call("GET", namespacePath(namespace, "/keys"))) as { keys: KeySnapshot[] })
        .keys;
    },
    async revokeKey(keyId) {
      return (await call(
        "POST",
        `/v1/admin/keys/${encodeURIComponent(keyId)}/revoke`,
      )) as KeySnapshot;
    },
    async getQuota(namespace) {
      return (await call("GET", namespacePath(namespace, "/quota"))) as QuotaSnapshot;
    },
    async setQuota(namespace, changes) {
      return (await call("POST", namespacePath(namespace, "/quota"), changes)) as QuotaSnapshot;
    },
    async listAudit(filter) {
      const query = new URLSearchParams();
      if (filter.namespace !== undefined) {
        query.set("namespace", filter.namespace);
      }
      if (filter.limit !== undefined) {
        query.set("limit", String(filter.limit));
      }
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return ((await call("GET", `/v1/admin/audit-log${suffix}`)) as { entries: AuditSnapshot[] })
        .entries;
    },
  };
}
