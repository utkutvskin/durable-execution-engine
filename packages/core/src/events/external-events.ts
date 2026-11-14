import type { Pool, PoolClient } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.ts";
import { appendEventsOnClient, readCurrentSequenceOnClient } from "../event-store/event-store.ts";
import type { WorkflowEvent } from "../event-store/events.ts";
import { rollbackQuietly } from "../db/transaction.ts";
import { insertRunOnClient } from "../run/insert-run.ts";
import { systemClock, type ClockSource } from "../workflow/sources.ts";

/**
 * How long an event that no run waits for yet stays deliverable when the
 * sender does not say otherwise: one hour.
 */
export const DEFAULT_EVENT_BUFFER_MS = 60 * 60 * 1000;

/**
 * The longest buffer period an event may ask for: seven days.
 */
export const MAX_EVENT_BUFFER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What `sendEvent` sends: an event named `eventName` addressed by the
 * correlation key `key`. `bufferMs` is how long the event stays deliverable
 * to runs that start waiting for it later (default
 * `DEFAULT_EVENT_BUFFER_MS`, at most `MAX_EVENT_BUFFER_MS`, 0 for none).
 */
export interface SendEventInput {
  readonly eventName: string;
  readonly key: string;
  readonly payload?: unknown;
  readonly bufferMs?: number;
}

/**
 * One wait an event was delivered to.
 */
export interface EventDelivery {
  readonly runId: string;
  readonly waitId: string;
}

/**
 * What `sendEvent` returns: the stored event's id and expiry, the waits it
 * was delivered to at once, and the runs its triggers started.
 */
export interface SendEventReceipt {
  readonly eventId: string;
  readonly expiresAt: Date;
  readonly deliveredTo: readonly EventDelivery[];
  readonly startedRunIds: readonly string[];
}

/**
 * What `createTrigger` registers: every event named `eventName` (and, when
 * `key` is given, carrying exactly that correlation key) starts a run of
 * `workflowType` on `queueName` (default `"default"`). The run's input is
 * `{ eventId, eventName, key, payload }`.
 */
export interface CreateEventTriggerInput {
  readonly eventName: string;
  readonly key?: string | undefined;
  readonly workflowType: string;
  readonly queueName?: string | undefined;
}

/**
 * A registered event trigger.
 */
export interface EventTrigger {
  readonly id: string;
  readonly eventName: string;
  readonly key: string | undefined;
  readonly workflowType: string;
  readonly queueName: string;
  readonly createdAt: Date;
}

/**
 * The input a run started by an event trigger receives.
 */
export interface TriggeredRunInput {
  readonly eventId: string;
  readonly eventName: string;
  readonly key: string;
  readonly payload: unknown;
}

/**
 * Sends external events to waiting runs and manages event triggers.
 */
export interface EventService {
  /**
   * Stores the event, delivers it to every open `ctx.waitForEvent()` wait
   * for its name and key and starts a run for every matching trigger, all in
   * one transaction. A run that starts waiting later receives the event as
   * long as it is inside its buffer period. Each run receives one event at
   * most once. Rejects with `RangeError` for an empty name or a bad buffer.
   */
  sendEvent(namespaceId: string, input: SendEventInput): Promise<SendEventReceipt>;
  /**
   * Registers an event trigger. Rejects with `RangeError` for an empty
   * event name or workflow type.
   */
  createTrigger(namespaceId: string, input: CreateEventTriggerInput): Promise<EventTrigger>;
  /**
   * Lists the namespace's event triggers, oldest first.
   */
  listTriggers(namespaceId: string): Promise<EventTrigger[]>;
}

/**
 * Options for `createEventService`. `clock` decides when an event and a wait
 * expire, and should be the clock the timer scheduler fires timers by.
 */
export interface EventServiceOptions {
  readonly codec?: Codec;
  readonly clock?: ClockSource;
}

interface WaitRow {
  run_id: string;
  wait_id: string;
}

interface TriggerRow {
  id: string;
  event_name: string;
  correlation_key: string | null;
  workflow_type: string;
  queue_name: string;
  created_at: Date;
}

function toTrigger(row: TriggerRow): EventTrigger {
  return {
    id: row.id,
    eventName: row.event_name,
    key: row.correlation_key ?? undefined,
    workflowType: row.workflow_type,
    queueName: row.queue_name,
    createdAt: row.created_at,
  };
}

function validateEvent(input: SendEventInput): number {
  if (input.eventName.length === 0) {
    throw new RangeError("eventName must not be empty");
  }
  const bufferMs = input.bufferMs ?? DEFAULT_EVENT_BUFFER_MS;
  if (!Number.isInteger(bufferMs) || bufferMs < 0 || bufferMs > MAX_EVENT_BUFFER_MS) {
    throw new RangeError(
      `bufferMs must be an integer from 0 to ${String(MAX_EVENT_BUFFER_MS)}, got ${String(bufferMs)}`,
    );
  }
  return bufferMs;
}

/**
 * Takes the transaction-level lock that serializes sending an event and
 * registering a wait for the same name and key in a namespace, so an event
 * and a wait that race are always paired.
 */
export async function lockEventAddressOnClient(
  client: PoolClient,
  namespaceId: string,
  eventName: string,
  key: string,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 46))", [
    JSON.stringify([namespaceId, eventName, key]),
  ]);
}

/**
 * Delivers the stored event `eventId` to the wait `waitId` of `runId` inside
 * the caller's transaction: appends `event_received`, marks the wait
 * delivered and enqueues a workflow task. Takes the run row lock. Delivers
 * nothing (and returns `false`) when the run is closed, the wait is already
 * delivered or has expired, or the run already received this event.
 */
export async function deliverEventOnClient(
  client: PoolClient,
  codec: Codec,
  delivery: EventDelivery,
  event: {
    readonly eventId: string;
    readonly eventName: string;
    readonly key: string;
    readonly payload: unknown;
  },
  now: Date,
): Promise<boolean> {
  const run = await client.query<{ namespace_id: string; status: string; queue_name: string }>(
    "select namespace_id, status, queue_name from workflow_runs where id = $1 for update",
    [delivery.runId],
  );
  const row = run.rows[0];
  if (row?.status !== "RUNNING") {
    return false;
  }
  const marked = await client.query(
    `update event_waits set delivered_event_id = $3, delivered_at = $4
     where run_id = $1 and wait_id = $2 and delivered_at is null
       and (expires_at is null or expires_at > $4)
       and not exists (
         select 1 from event_waits other
         where other.run_id = $1 and other.delivered_event_id = $3
       )`,
    [delivery.runId, delivery.waitId, event.eventId, now],
  );
  if (marked.rowCount !== 1) {
    return false;
  }
  const currentSeq = await readCurrentSequenceOnClient(client, delivery.runId);
  await appendEventsOnClient(client, codec, delivery.runId, currentSeq, [
    {
      type: "event_received",
      waitId: delivery.waitId,
      eventId: event.eventId,
      eventName: event.eventName,
      key: event.key,
      payload: event.payload,
    },
  ]);
  await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
     values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
    [
      row.namespace_id,
      delivery.runId,
      row.queue_name,
      JSON.stringify({ reason: "event", eventName: event.eventName }),
    ],
  );
  return true;
}

/**
 * Records the wait an `event_wait_started` event describes inside the
 * caller's transaction and, when a buffered event for its name and key is
 * still inside its buffer period and has not reached this run yet, delivers
 * the oldest one at once. The caller must hold the address lock (see
 * `lockEventAddressOnClient`) and then the run row lock, in that order.
 */
export async function registerEventWaitOnClient(
  client: PoolClient,
  codec: Codec,
  runId: string,
  wait: Extract<WorkflowEvent, { type: "event_wait_started" }>,
  now: Date,
): Promise<boolean> {
  const inserted = await client.query<{ namespace_id: string }>(
    `insert into event_waits (run_id, wait_id, namespace_id, event_name, correlation_key, expires_at)
     select id, $2, namespace_id, $3, $4, $5 from workflow_runs where id = $1
     on conflict (run_id, wait_id) do nothing
     returning namespace_id`,
    [runId, wait.waitId, wait.eventName, wait.key, wait.expiresAt ?? null],
  );
  const namespaceId = inserted.rows[0]?.namespace_id;
  if (namespaceId === undefined) {
    return false;
  }
  const buffered = await client.query<{ id: string; payload: unknown }>(
    `select e.id, e.payload from external_events e
     where e.namespace_id = $1 and e.event_name = $2 and e.correlation_key = $3
       and e.expires_at > $4
       and not exists (
         select 1 from event_waits w where w.run_id = $5 and w.delivered_event_id = e.id
       )
     order by e.received_at, e.id
     limit 1`,
    [namespaceId, wait.eventName, wait.key, now, runId],
  );
  const event = buffered.rows[0];
  if (event === undefined) {
    return false;
  }
  return deliverEventOnClient(
    client,
    codec,
    { runId, waitId: wait.waitId },
    { eventId: event.id, eventName: wait.eventName, key: wait.key, payload: event.payload },
    now,
  );
}

/**
 * Sends an event inside the caller's open transaction on `client`. See
 * `EventService.sendEvent`.
 */
export async function sendEventOnClient(
  client: PoolClient,
  codec: Codec,
  namespaceId: string,
  input: SendEventInput,
  now: Date,
): Promise<SendEventReceipt> {
  const bufferMs = validateEvent(input);
  const payload = input.payload ?? null;
  await lockEventAddressOnClient(client, namespaceId, input.eventName, input.key);
  const expiresAt = new Date(now.getTime() + bufferMs);
  const stored = await client.query<{ id: string }>(
    `insert into external_events
       (namespace_id, event_name, correlation_key, payload, received_at, expires_at)
     values ($1, $2, $3, $4::jsonb, $5, $6)
     returning id`,
    [namespaceId, input.eventName, input.key, JSON.stringify(payload), now, expiresAt],
  );
  const eventId = stored.rows[0]?.id;
  if (eventId === undefined) {
    throw new Error(`event "${input.eventName}" was not stored`);
  }
  const waits = await client.query<WaitRow>(
    `select run_id, wait_id from event_waits
     where namespace_id = $1 and event_name = $2 and correlation_key = $3
       and delivered_at is null and (expires_at is null or expires_at > $4)
     order by run_id, wait_id`,
    [namespaceId, input.eventName, input.key, now],
  );
  const deliveredTo: EventDelivery[] = [];
  const event = { eventId, eventName: input.eventName, key: input.key, payload };
  for (const wait of waits.rows) {
    const delivery = { runId: wait.run_id, waitId: wait.wait_id };
    if (await deliverEventOnClient(client, codec, delivery, event, now)) {
      deliveredTo.push(delivery);
    }
  }
  const triggers = await client.query<TriggerRow>(
    `select id, event_name, correlation_key, workflow_type, queue_name, created_at
     from event_triggers
     where namespace_id = $1 and event_name = $2
       and (correlation_key is null or correlation_key = $3)
     order by created_at, id`,
    [namespaceId, input.eventName, input.key],
  );
  const startedRunIds: string[] = [];
  for (const trigger of triggers.rows) {
    const runInput: TriggeredRunInput = {
      eventId,
      eventName: input.eventName,
      key: input.key,
      payload,
    };
    const runId = await insertRunOnClient(client, codec, {
      namespaceId,
      workflowType: trigger.workflow_type,
      input: runInput,
      queueName: trigger.queue_name,
      idempotencyKey: `event:${eventId}:${trigger.id}`,
      taskReason: "event_trigger",
    });
    if (runId !== undefined) {
      startedRunIds.push(runId);
    }
  }
  return { eventId, expiresAt, deliveredTo, startedRunIds };
}

/**
 * Creates an `EventService` over `pool`.
 */
export function createEventService(pool: Pool, options: EventServiceOptions = {}): EventService {
  const codec = options.codec ?? jsonCodec;
  const clock = options.clock ?? systemClock;

  return {
    async sendEvent(namespaceId, input) {
      validateEvent(input);
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query("begin");
        const receipt = await sendEventOnClient(client, codec, namespaceId, input, clock.now());
        await client.query("commit");
        return receipt;
      } catch (error) {
        broken = !(await rollbackQuietly(client));
        throw error;
      } finally {
        client.release(broken);
      }
    },

    async createTrigger(namespaceId, input) {
      if (input.eventName.length === 0) {
        throw new RangeError("eventName must not be empty");
      }
      if (input.workflowType.length === 0) {
        throw new RangeError("workflowType must not be empty");
      }
      const inserted = await pool.query<TriggerRow>(
        `insert into event_triggers (namespace_id, event_name, correlation_key, workflow_type, queue_name)
         values ($1, $2, $3, $4, $5)
         returning id, event_name, correlation_key, workflow_type, queue_name, created_at`,
        [
          namespaceId,
          input.eventName,
          input.key ?? null,
          input.workflowType,
          input.queueName ?? "default",
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error(`trigger for event "${input.eventName}" was not stored`);
      }
      return toTrigger(row);
    },

    async listTriggers(namespaceId) {
      const rows = await pool.query<TriggerRow>(
        `select id, event_name, correlation_key, workflow_type, queue_name, created_at
         from event_triggers where namespace_id = $1 order by created_at, id`,
        [namespaceId],
      );
      return rows.rows.map(toTrigger);
    },
  };
}
