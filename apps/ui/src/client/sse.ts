/**
 * One complete server sent event.
 */
export interface SseMessage {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: string;
}

/**
 * Creates an incremental parser for a server sent events stream. Feed it
 * decoded text chunks of any size; it calls `onMessage` once per complete
 * event and ignores comment lines such as heartbeats.
 */
export function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
  let buffer = "";

  function dispatch(block: string): void {
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":") || line.length === 0) {
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") {
        event = value;
      } else if (field === "id") {
        id = value;
      } else if (field === "data") {
        data.push(value);
      }
    }
    if (data.length > 0) {
      onMessage({ event, id, data: data.join("\n") });
    }
  }

  return (chunk) => {
    buffer += chunk.replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  };
}
