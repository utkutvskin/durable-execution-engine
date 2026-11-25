import type { Pool } from "@dee/core";
import type { ApiKeyScope, AuthenticatedNamespace } from "./api-keys.ts";

/**
 * One admin or operator action to record. `namespace` is the namespace the
 * action changed, `target` what inside it (a run, a key, a task), and
 * `details` the parameters that matter, never a secret.
 */
export interface AuditEntryInput {
  readonly actor: AuthenticatedNamespace;
  readonly action: string;
  readonly namespace: string | null;
  readonly target: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * A recorded action. The actor is copied into the entry, so it stays
 * readable after the key is revoked.
 */
export interface AuditEntry {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorKeyId: string;
  readonly actorLabel: string;
  readonly actorNamespace: string;
  readonly actorScope: ApiKeyScope;
  readonly namespace: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * Which entries `AuditLog.list` returns: those of one namespace, before the
 * entry id `before` (the cursor of the previous page), newest first.
 */
export interface AuditQuery {
  readonly namespace?: string | undefined;
  readonly before?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * The append-only record of admin and operator actions. The table refuses
 * updates and deletes.
 */
export interface AuditLog {
  /** Appends one entry and resolves its id. */
  record(entry: AuditEntryInput): Promise<string>;

  /** Reads entries newest first. */
  list(query?: AuditQuery): Promise<AuditEntry[]>;
}

/**
 * The most entries one `AuditLog.list` call returns.
 */
export const MAX_AUDIT_PAGE = 500;

const DEFAULT_AUDIT_PAGE = 100;

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_key_id: string;
  actor_label: string;
  actor_namespace: string;
  actor_scope: ApiKeyScope;
  namespace: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

/**
 * Creates the `AuditLog` over `pool`.
 */
export function createAuditLog(pool: Pool): AuditLog {
  return {
    async record(entry: AuditEntryInput): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `insert into audit_log
           (actor_key_id, actor_label, actor_namespace, actor_scope, namespace, action, target, details)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         returning id::text`,
        [
          entry.actor.keyId,
          entry.actor.label,
          entry.actor.namespace,
          entry.actor.scope,
          entry.namespace,
          entry.action,
          entry.target,
          JSON.stringify(entry.details),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("the audit entry could not be stored");
      }
      return row.id;
    },

    async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
      const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_AUDIT_PAGE), MAX_AUDIT_PAGE);
      const result = await pool.query<AuditRow>(
        `select id::text, occurred_at, actor_key_id, actor_label, actor_namespace, actor_scope,
                namespace, action, target, details
         from audit_log
         where ($1::text is null or namespace = $1)
           and ($2::bigint is null or audit_log.id < $2)
         order by audit_log.id desc
         limit $3`,
        [query.namespace ?? null, query.before ?? null, limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at,
        actorKeyId: row.actor_key_id,
        actorLabel: row.actor_label,
        actorNamespace: row.actor_namespace,
        actorScope: row.actor_scope,
        namespace: row.namespace,
        action: row.action,
        target: row.target,
        details: row.details,
      }));
    },
  };
}
