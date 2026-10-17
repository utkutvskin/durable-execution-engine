import { describe, expect, it } from "vitest";
import { createSseParser, type SseMessage } from "./sse.js";

function collect(): { messages: SseMessage[]; feed: (chunk: string) => void } {
  const messages: SseMessage[] = [];
  return { messages, feed: createSseParser((message) => messages.push(message)) };
}

describe("createSseParser", () => {
  it("emits one message per blank line terminated block", () => {
    const { messages, feed } = collect();
    feed('id: 4\nevent: slice\ndata: {"a":1}\n\n');
    expect(messages).toEqual([{ event: "slice", id: "4", data: '{"a":1}' }]);
  });

  it("joins a message that arrives in arbitrary chunks", () => {
    const { messages, feed } = collect();
    for (const piece of ["event: sl", "ice\nda", "ta: 12", "3\n", "\n"]) {
      feed(piece);
    }
    expect(messages).toEqual([{ event: "slice", id: undefined, data: "123" }]);
  });

  it("ignores comment lines such as the open marker and heartbeats", () => {
    const { messages, feed } = collect();
    feed(": open\n\n: ping\n\nevent: end\ndata: {}\n\n");
    expect(messages.map((message) => message.event)).toEqual(["end"]);
  });

  it("joins several data lines with a newline and accepts crlf", () => {
    const { messages, feed } = collect();
    feed("data: one\r\ndata: two\r\n\r\n");
    expect(messages).toEqual([{ event: "message", id: undefined, data: "one\ntwo" }]);
  });

  it("emits several messages from one chunk", () => {
    const { messages, feed } = collect();
    feed("data: 1\n\ndata: 2\n\n");
    expect(messages.map((message) => message.data)).toEqual(["1", "2"]);
  });
});
