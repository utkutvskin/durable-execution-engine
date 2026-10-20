import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createIsolatedDatabase,
  createIsolatedSchema,
  type IsolatedSchema,
} from "../../core/src/db/test-harness.js";
import { readDevState } from "./config.js";
import type { CliIo } from "./io.js";
import { main } from "./main.js";
import { urlForSchema } from "./test-support.js";

function captureIo(cwd: string, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env,
    cwd,
  };
  return { io, out, err };
}

describe("wf against a real database", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "wf-cli-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe("migrate", () => {
    let schema: IsolatedSchema;

    beforeAll(async () => {
      schema = await createIsolatedSchema();
    });

    afterAll(async () => {
      await schema.close();
    });

    it("applies every migration, then reports a current schema, then reverts steps", async () => {
      const env = { DATABASE_URL: urlForSchema(schema.schema) };
      const first = captureIo(directory, env);
      expect(await main(["migrate"], first.io)).toBe(0);
      expect(first.out.length).toBeGreaterThanOrEqual(16);
      expect(first.out.every((line) => line.startsWith("applied "))).toBe(true);
      const second = captureIo(directory, env);
      expect(await main(["migrate", "up"], second.io)).toBe(0);
      expect(second.out).toEqual(["nothing to apply, the schema is current"]);
      const down = captureIo(directory, env);
      expect(await main(["migrate", "down", "--steps", "2"], down.io)).toBe(0);
      expect(down.out).toHaveLength(2);
      expect(down.out.every((line) => line.startsWith("reverted "))).toBe(true);
      const again = captureIo(directory, env);
      await main(["migrate"], again.io);
      expect(again.out).toHaveLength(2);
    });

    it("rejects a bad direction and a bad step count", async () => {
      const env = { DATABASE_URL: urlForSchema(schema.schema) };
      expect(await main(["migrate", "sideways"], captureIo(directory, env).io)).toBe(2);
      expect(await main(["migrate", "down", "--steps", "0"], captureIo(directory, env).io)).toBe(2);
    });
  });

  describe("dev and run", () => {
    let database: IsolatedSchema;

    beforeAll(async () => {
      database = await createIsolatedDatabase();
    });

    afterAll(async () => {
      await database.close();
    });

    it("brings up the api, ui and a worker and lets wf run drive a payment saga", async () => {
      const env = { DATABASE_URL: urlForSchema(database.schema) };
      const dev = captureIo(directory, env);
      let stop: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      const running = main(["dev", "--port", "0", "--example", "payment-saga"], dev.io, {
        shutdown: () => stopped,
      });
      let state = await readDevState(directory);
      for (let attempt = 0; attempt < 400 && state === undefined; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        state = await readDevState(directory);
      }
      expect(state).toBeDefined();
      expect(dev.out.join("\n")).toContain("api and ui listening on http://127.0.0.1:");

      const ui = await fetch(`${state?.apiUrl ?? ""}/ui/`);
      expect(ui.status).toBe(200);

      const client = captureIo(directory);
      const code = await main(
        [
          "run",
          "start",
          "payment-saga",
          "--input",
          '{"orderId":"cli-1","customerId":"c1","amountCents":1200}',
          "--wait",
          "--json",
        ],
        client.io,
      );
      expect(code).toBe(0);
      const finished = JSON.parse(client.out[0] ?? "{}") as {
        status: string;
        result: { status: string };
      };
      expect(finished.status).toBe("COMPLETED");
      expect(finished.result.status).toBe("captured");

      const listed = captureIo(directory);
      await main(["run", "list", "--type", "payment-saga"], listed.io);
      expect(listed.out[0]).toContain("COMPLETED");

      stop();
      expect(await running).toBe(0);
      expect(dev.out.at(-1)).toBe("stopping");
    });

    it("refuses a run command with a wrong api key", async () => {
      const wrong = captureIo(directory, { WF_API_URL: "http://127.0.0.1:1", WF_API_KEY: "nope" });
      expect(await main(["run", "list"], wrong.io)).toBe(1);
    });
  });

  describe("example", () => {
    it("runs the payment saga example end to end with one command", async () => {
      const schema = await createIsolatedSchema();
      try {
        const run = captureIo(directory, { DATABASE_URL: urlForSchema(schema.schema) });
        expect(await main(["example", "payment-saga"], run.io)).toBe(0);
        expect(run.out).toContain("ok: payment-saga");
        expect(run.out.filter((line) => line.includes(" bad "))).toEqual([]);
      } finally {
        await schema.close();
      }
    });

    it("runs the etl pipeline example end to end with one command", async () => {
      const schema = await createIsolatedSchema();
      try {
        const run = captureIo(directory, { DATABASE_URL: urlForSchema(schema.schema) });
        expect(await main(["example", "etl-pipeline"], run.io)).toBe(0);
        expect(run.out).toContain("ok: etl-pipeline");
      } finally {
        await schema.close();
      }
    });

    it("rejects an unknown example name", async () => {
      const run = captureIo(directory, {});
      expect(await main(["example", "nope"], run.io)).toBe(2);
    });
  });
});
