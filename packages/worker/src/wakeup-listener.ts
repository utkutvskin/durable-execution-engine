import type { SessionConnection, SessionConnector } from "@dee/core";
import { systemTimers, type Timers } from "./timers.ts";

/**
 * The channel the `tasks` insert trigger notifies on, once per transaction
 * and queue, when `dee.notify_wakeups` is on for the inserting session.
 */
export const WAKEUP_CHANNEL = "dee_wakeup";

/**
 * Configuration for `startWakeupListener`. `onWake` is called for every
 * notification about `queueName` in the listener's schema, and once after
 * each reconnect, since notifications sent while the session was down are
 * lost. A lost session is reopened after `reconnectDelayMs` (default 1000).
 */
export interface WakeupListenerOptions {
  readonly connect: SessionConnector;
  readonly queueName: string;
  readonly onWake: () => void;
  readonly reconnectDelayMs?: number;
  readonly timers?: Timers;
  readonly onError?: (error: unknown) => void;
}

/**
 * A running wake-up listener.
 */
export interface WakeupListener {
  /** Resolves once the first `LISTEN` is in place (or failed). */
  readonly ready: Promise<void>;
  /** Whether a session is listening right now. */
  readonly listening: boolean;
  /** Stops listening and ends the session. */
  stop(): Promise<void>;
}

interface WakeupPayload {
  readonly schema?: unknown;
  readonly queue?: unknown;
}

function parsePayload(payload: string): WakeupPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Listens for task wake-ups of `queueName` on a dedicated session. It is a
 * hint only: a missed or late notification costs latency, never a task,
 * because the workers keep polling as the fallback.
 */
export function startWakeupListener(options: WakeupListenerOptions): WakeupListener {
  const timers = options.timers ?? systemTimers;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const onError = options.onError ?? ((): void => undefined);
  let session: SessionConnection | undefined;
  let stopped = false;
  let handle: unknown;
  let connecting: Promise<void> = Promise.resolve();
  const isStopped = (): boolean => stopped;

  function scheduleReconnect(): void {
    if (stopped || handle !== undefined) {
      return;
    }
    handle = timers.setTimeout(() => {
      handle = undefined;
      connecting = connect(true);
    }, reconnectDelayMs);
  }

  async function connect(reconnected: boolean): Promise<void> {
    if (stopped) {
      return;
    }
    let opened: SessionConnection | undefined;
    try {
      opened = await options.connect();
      const active = opened;
      const rows = await active.query<{ schema: string }>("select current_schema() as schema");
      const schema = rows[0]?.schema;
      active.onNotification((channel, payload) => {
        const message = parsePayload(payload);
        if (
          channel === WAKEUP_CHANNEL &&
          message !== undefined &&
          message.schema === schema &&
          message.queue === options.queueName
        ) {
          options.onWake();
        }
      });
      active.onLost((error) => {
        if (session !== active) {
          return;
        }
        session = undefined;
        onError(error);
        scheduleReconnect();
      });
      await active.query(`listen ${WAKEUP_CHANNEL}`);
      if (isStopped()) {
        await active.close();
        return;
      }
      session = active;
      if (reconnected) {
        options.onWake();
      }
    } catch (error) {
      onError(error);
      await opened?.close().catch(onError);
      scheduleReconnect();
    }
  }

  connecting = connect(false);
  const ready = connecting;

  return {
    ready,
    get listening(): boolean {
      return session !== undefined;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
      await connecting;
      const active = session;
      session = undefined;
      await active?.close().catch(onError);
    },
  };
}
