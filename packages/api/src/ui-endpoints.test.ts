import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeadLetterQueue, createPostgresEventStore } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.js";
import { createApiServer } from "./server.js";

interface SseFrame {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: Record<string, unknown>;
}

async function readFrames(
  response: Response,
  until: (frames: SseFrame[]) => boolean,
): Promise<SseFrame[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  while (!until(frames)) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = raw.split("\n").filter((line) => !line.startsWith(":"));
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event !== undefined && data !== undefined) {
        frames.push({
          event,
          id: lines.find((line) => line.startsWith("id: "))?.slice(4),
          data: JSON.parse(data) as Record<string, unknown>,
        });
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return frames;
}

describe("api endpoints behind the web ui", () => {
  let database: IsolatedSchema;
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let keyA: string;
  let keyB: string;
  let namespaceA: string;

  function headers(key: string | undefined): Record<string, string> {
    return key === undefined
      ? {}
      : { authorization: `Bearer ${key}`, "content-type": "application/json" };
  }

  async function start(key: string, workflowType = "order"): Promise<string> {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ workflowType, input: { n: 1 } }),
    });
    return ((await response.json()) as { run: { runId: string } }).run.runId;
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const api = createApiServer(database.pool, { queueName: "default", streamPollMs: 10 });
    await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${String((api.server.address() as AddressInfo).port)}`;
    closeServer = () =>
      new Promise<void>((resolve) => {
        api.server.close(() => {
          resolve();
        });
        api.server.closeAllConnections();
      });
    const issuedA = await api.apiKeys.issue("namespace-a");
    keyA = issuedA.key;
    namespaceA = issuedA.namespaceId;
    keyB = (await api.apiKeys.issue("namespace-b")).key;
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  describe("namespace", () => {
    it("names the namespace of the key", async () => {
      const response = await fetch(`${baseUrl}/v1/namespace`, { headers: headers(keyA) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: namespaceA, name: "namespace-a" });
    });

    it("answers 401 without a key", async () => {
      const response = await fetch(`${baseUrl}/v1/namespace`);
      expect(response.status).toBe(401);
    });
  });

  describe("list date filters", () => {
    it("keeps runs started inside the window and drops the others", async () => {
      const early = await start(keyA, "dated");
      const late = await start(keyA, "dated");
      await database.pool.query(
        "update workflow_runs set started_at = '2026-01-10T00:00:00Z' where id = $1",
        [early],
      );
      await database.pool.query(
        "update workflow_runs set started_at = '2026-02-10T00:00:00Z' where id = $1",
        [late],
      );
      const list = async (query: string): Promise<string[]> => {
        const response = await fetch(`${baseUrl}/v1/runs?workflowType=dated&${query}`, {
          headers: headers(keyA),
        });
        return ((await response.json()) as { runs: { runId: string }[] }).runs.map(
          (run) => run.runId,
        );
      };
      expect(await list("startedAfter=2026-02-01T00:00:00Z")).toEqual([late]);
      expect(await list("startedBefore=2026-02-01T00:00:00Z")).toEqual([early]);
      expect(
        await list("startedAfter=2026-01-01T00:00:00Z&startedBefore=2026-03-01T00:00:00Z"),
      ).toEqual([late, early]);
    });

    it("rejects a date that is not iso 8601", async () => {
      const response = await fetch(`${baseUrl}/v1/runs?startedAfter=yesterday`, {
        headers: headers(keyA),
      });
      expect(response.status).toBe(400);
    });
  });

  describe("dead letters", () => {
    async function deadLetter(namespaceId: string, runId: string, stepId: string): Promise<string> {
      return createDeadLetterQueue(database.pool).add({
        namespaceId,
        runId,
        stepId,
        queueName: "default/steps",
        payload: { stepId, stepType: "charge", input: {} },
        attempts: 3,
        error: { name: "ChargeError", message: "card declined" },
        reason: "MAX_ATTEMPTS_EXHAUSTED",
      });
    }

    it("lists only the callers dead letters", async () => {
      const runA = await start(keyA);
      const runB = await start(keyB);
      const idA = await deadLetter(namespaceA, runA, "step-1");
      const namespaceB = (
        await database.pool.query<{ namespace_id: string }>(
          "select namespace_id from workflow_runs where id = $1",
          [runB],
        )
      ).rows[0]?.namespace_id;
      await deadLetter(namespaceB ?? "", runB, "step-1");
      const response = await fetch(`${baseUrl}/v1/dead-letters`, { headers: headers(keyA) });
      const body = (await response.json()) as {
        deadLetters: { id: string; runId: string; error: { message: string } }[];
      };
      expect(body.deadLetters.map((letter) => letter.id)).toEqual([idA]);
      expect(body.deadLetters[0]?.runId).toBe(runA);
      expect(body.deadLetters[0]?.error.message).toBe("card declined");
    });

    it("requeues once, creates a step task and then answers 404", async () => {
      const run = await start(keyA);
      const id = await deadLetter(namespaceA, run, "step-2");
      const first = await fetch(`${baseUrl}/v1/dead-letters/${id}/requeue`, {
        method: "POST",
        headers: headers(keyA),
        body: "{}",
      });
      expect(first.status).toBe(200);
      const { taskId } = (await first.json()) as { taskId: string };
      const task = await database.pool.query<{ task_type: string; queue_name: string }>(
        "select task_type, queue_name from tasks where id = $1",
        [taskId],
      );
      expect(task.rows[0]).toEqual({ task_type: "STEP_TASK", queue_name: "default/steps" });
      const second = await fetch(`${baseUrl}/v1/dead-letters/${id}/requeue`, {
        method: "POST",
        headers: headers(keyA),
        body: "{}",
      });
      expect(second.status).toBe(404);
    });

    it("answers 404 for another namespace's dead letter and leaves it waiting", async () => {
      const run = await start(keyA);
      const id = await deadLetter(namespaceA, run, "step-3");
      const response = await fetch(`${baseUrl}/v1/dead-letters/${id}/requeue`, {
        method: "POST",
        headers: headers(keyB),
        body: "{}",
      });
      expect(response.status).toBe(404);
      const waiting = await database.pool.query(
        "select 1 from dead_letters where id = $1 and requeued_at is null",
        [id],
      );
      expect(waiting.rowCount).toBe(1);
    });

    it("answers 404 for a malformed id", async () => {
      const response = await fetch(`${baseUrl}/v1/dead-letters/not-a-uuid/requeue`, {
        method: "POST",
        headers: headers(keyA),
        body: "{}",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("run stream", () => {
    it("sends the history so far, then events appended later, then ends when the run closes", async () => {
      const runId = await start(keyA, "streamed");
      const store = createPostgresEventStore(database.pool);
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/stream`, {
        headers: headers(keyA),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      setTimeout(() => {
        void store
          .append(runId, 1, [{ type: "signal_received", signalName: "go", payload: null }])
          .then(() => store.append(runId, 2, [{ type: "run_completed", result: 7 }]))
          .then(() =>
            database.pool.query("update workflow_runs set status = 'COMPLETED' where id = $1", [
              runId,
            ]),
          );
      }, 50);
      const frames = await readFrames(response, (seen) =>
        seen.some((frame) => frame.event === "end"),
      );
      const types = frames
        .filter((frame) => frame.event === "slice")
        .flatMap((frame) =>
          (frame.data["events"] as { event: { type: string } }[]).map((entry) => entry.event.type),
        );
      expect(types).toEqual(["run_started", "signal_received", "run_completed"]);
      expect(frames.at(-1)?.event).toBe("end");
    });

    it("resumes after the sequence number in Last-Event-ID", async () => {
      const runId = await start(keyA, "resumed");
      const store = createPostgresEventStore(database.pool);
      await store.append(runId, 1, [{ type: "run_completed", result: 1 }]);
      await database.pool.query("update workflow_runs set status = 'COMPLETED' where id = $1", [
        runId,
      ]);
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/stream`, {
        headers: { ...headers(keyA), "last-event-id": "1" },
      });
      const frames = await readFrames(response, (seen) =>
        seen.some((frame) => frame.event === "end"),
      );
      const sequences = frames
        .filter((frame) => frame.event === "slice")
        .flatMap((frame) =>
          (frame.data["events"] as { sequenceNumber: number }[]).map(
            (entry) => entry.sequenceNumber,
          ),
        );
      expect(sequences).toEqual([2]);
    });

    it("answers 404 for another namespace's run and 401 without a key", async () => {
      const runId = await start(keyA);
      const other = await fetch(`${baseUrl}/v1/runs/${runId}/stream`, { headers: headers(keyB) });
      expect(other.status).toBe(404);
      const anonymous = await fetch(`${baseUrl}/v1/runs/${runId}/stream`);
      expect(anonymous.status).toBe(401);
    });

    it("rejects a cursor that is not a number", async () => {
      const runId = await start(keyA);
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/stream?after=abc`, {
        headers: headers(keyA),
      });
      expect(response.status).toBe(400);
    });
  });
});
