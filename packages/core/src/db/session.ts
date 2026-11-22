import pg from "pg";
import type { Pool, PoolClient } from "pg";

const { Client } = pg;

/**
 * One dedicated Postgres session, held for as long as the caller needs it:
 * the session that owns an advisory lock or a `LISTEN`. It is never shared
 * with other work, so session state survives between statements. A
 * connection pooler in transaction mode cannot provide this, see
 * `docs/DEPLOYMENT.md`.
 */
export interface SessionConnection {
  /** Runs one statement on this session and resolves its rows. */
  query<Row>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]>;
  /** Registers a listener for `NOTIFY` messages on the channels this session listens on. */
  onNotification(listener: (channel: string, payload: string) => void): void;
  /**
   * Registers a listener called once when the session ends without `close`,
   * for example when the server terminated it or the network dropped it.
   */
  onLost(listener: (error: unknown) => void): void;
  /** Ends the session. Its session advisory locks and listens end with it. */
  close(): Promise<void>;
}

/**
 * Opens a new `SessionConnection`.
 */
export type SessionConnector = () => Promise<SessionConnection>;

/**
 * Options for `createSessionConnector`. With `connectionString`, sessions
 * connect there instead of where the pool connects, which is how a
 * deployment behind a transaction-mode pooler reaches Postgres directly.
 */
export interface SessionConnectorOptions {
  readonly connectionString?: string;
}

interface Listeners {
  readonly notification: ((channel: string, payload: string) => void)[];
  readonly lost: ((error: unknown) => void)[];
  closed: boolean;
  lostReported: boolean;
}

function reportLost(listeners: Listeners, error: unknown): void {
  if (listeners.closed || listeners.lostReported) {
    return;
  }
  listeners.lostReported = true;
  listeners.lost.forEach((listener) => {
    listener(error);
  });
}

function wrap(
  client: pg.Client | PoolClient,
  listeners: Listeners,
  end: () => Promise<void>,
): SessionConnection {
  client.on("notification", (message) => {
    listeners.notification.forEach((listener) => {
      listener(message.channel, message.payload ?? "");
    });
  });
  client.on("error", (error) => {
    reportLost(listeners, error);
  });
  client.on("end", () => {
    reportLost(listeners, new Error("session connection ended"));
  });
  return {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
      const result = await client.query(sql, [...values]);
      return result.rows as Row[];
    },
    onNotification(listener): void {
      listeners.notification.push(listener);
    },
    onLost(listener): void {
      listeners.lost.push(listener);
    },
    async close(): Promise<void> {
      if (listeners.closed) {
        return;
      }
      listeners.closed = true;
      await end();
    },
  };
}

/**
 * Creates a `SessionConnector` for `pool`. Each session is its own
 * connection, opened with the pool's settings (or at `connectionString`),
 * outside the pool, so it takes no slot from it. A pool without readable
 * settings lends one of its connections instead, held until `close`.
 */
export function createSessionConnector(
  pool: Pool,
  options: SessionConnectorOptions = {},
): SessionConnector {
  return async (): Promise<SessionConnection> => {
    const listeners: Listeners = {
      notification: [],
      lost: [],
      closed: false,
      lostReported: false,
    };
    const poolOptions = (pool as { options?: pg.PoolConfig }).options;
    if (options.connectionString === undefined && poolOptions === undefined) {
      const lent = await pool.connect();
      return wrap(lent, listeners, () => {
        lent.removeAllListeners("notification");
        lent.release(true);
        return Promise.resolve();
      });
    }
    const client = new Client(
      options.connectionString === undefined
        ? { ...poolOptions }
        : {
            connectionString: options.connectionString,
            ...(poolOptions?.options === undefined ? {} : { options: poolOptions.options }),
          },
    );
    client.on("error", () => undefined);
    await client.connect();
    return wrap(client, listeners, () => client.end());
  };
}
