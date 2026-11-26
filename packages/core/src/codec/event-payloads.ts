import type { WorkflowEvent } from "../event-store/events.ts";
import type { PayloadCodec } from "./payload-codec.ts";

type Transform = (value: unknown) => unknown;

function mapEventPayloads(event: WorkflowEvent, transform: Transform): WorkflowEvent {
  switch (event.type) {
    case "run_started":
    case "step_scheduled":
    case "child_started":
      return { ...event, input: transform(event.input) };
    case "run_completed":
    case "step_completed":
    case "child_completed":
    case "update_completed":
      return { ...event, result: transform(event.result) };
    case "signal_received":
    case "event_received":
      return { ...event, payload: transform(event.payload) };
    case "update_accepted":
      return { ...event, argument: transform(event.argument) };
    case "run_continued_as_new":
      return event.signals === undefined
        ? { ...event, input: transform(event.input) }
        : {
            ...event,
            input: transform(event.input),
            signals: event.signals.map((signal) => ({
              ...signal,
              payload: transform(signal.payload),
            })),
          };
    default:
      return event;
  }
}

/**
 * Returns `event` with each of its user payloads (inputs, results, signal,
 * update and event payloads) encoded by `codec`. Ids, types, timestamps,
 * errors and search attributes stay as they are, so the engine and SQL can
 * still read them.
 */
export function encodeEventPayloads(codec: PayloadCodec, event: WorkflowEvent): WorkflowEvent {
  return mapEventPayloads(event, (value) => codec.encode(value));
}

/**
 * The inverse of `encodeEventPayloads`: the event with each user payload
 * decoded by `codec`. Payloads that are not encoded come back unchanged.
 */
export function decodeEventPayloads(codec: PayloadCodec, event: WorkflowEvent): WorkflowEvent {
  return mapEventPayloads(event, (value) => codec.decode(value));
}
