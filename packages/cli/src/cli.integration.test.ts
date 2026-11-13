import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createIsolatedDatabase,
  createIsolatedSchema,
  type IsolatedSchema,
} from "../../core/src/db/test-harness.ts";
import { readDevState } from "./config.ts";
import type { CliIo } from "./io.ts";
import { main } from "./main.ts";
import { urlForSchema } from "./test-support.ts";

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
      expect(await main(["migrate", "down", "--steps", "2", "--yes"], down.io)).toBe(0);
      expect(down.out).toHaveLength(2);
      expect(down.out.every((line) => line.startsWith("reverted "))).toBe(true);
      const again = captureIo(directory, env);
      await main(["migrate"], again.io);
      expect(again.out).toHaveLength(2);
    });

    it("rejects a bad direction and a bad step count", async () => {
      const env = { DATABASE_URL: urlForSchema(schema.schema) };
      expect(await main(["migrate", "sideways"], captureIo(directory, env).io)).toBe(2);
      expect(
        await main(["migrate", "down", "--steps", "0", "--yes"], captureIo(directory, env).io),
      ).toBe(2);
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

      const runId = (JSON.parse(client.out[0] ?? "{}") as { runId: string }).runId;
      const exported = captureIo(directory);
      expect(await main(["history", "export", runId, "--out", "saga.json"], exported.io)).toBe(0);
      const same = captureIo(directory);
      expect(await main(["replay", "--example", "payment-saga", "saga.json"], same.io)).toBe(0);
      expect(same.out).toEqual([
        expect.stringMatching(
          new RegExp(`^ok    run ${runId} \\(saga\\.json\\): \\d+ events replayed$`),
        ),
        "1 passed, 0 failed",
      ]);
      const changed = captureIo(directory);
      const changedModule = path.join(import.meta.dirname, "fixtures", "payment-saga-changed.ts");
      expect(await main(["replay", "--module", changedModule, "saga.json"], changed.io)).toBe(1);
      expect(changed.err[0]).toMatch(
        new RegExp(
          `^FAIL  run ${runId} \\(saga\\.json\\): non determinism at event 2 \\(step_scheduled\\): `,
        ),
      );

      stop();
      expect(await running).toBe(0);
      expect(dev.out.at(-1)).toBe("stopping");
    });

    it("drives a run with wf run update and wf run query and replays its history", async () => {
      const env = { DATABASE_URL: urlForSchema(database.schema) };
      const cartModule = path.join(import.meta.dirname, "fixtures", "cart-module.ts");
      const dev = captureIo(directory, env);
      let stop: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      const running = main(["dev", "--port", "0", "--module", cartModule], dev.io, {
        shutdown: () => stopped,
      });
      let state = await readDevState(directory);
      for (let attempt = 0; attempt < 400 && state === undefined; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        state = await readDevState(directory);
      }
      expect(state).toBeDefined();

      const started = captureIo(directory);
      expect(await main(["run", "start", "cart"], started.io)).toBe(0);
      const runId = started.out[0] ?? "";

      const first = captureIo(directory);
      expect(await main(["run", "update", runId, "add", "--argument", '"apple"'], first.io)).toBe(
        0,
      );
      expect(first.out).toEqual(["500"]);
      const second = captureIo(directory);
      expect(await main(["run", "update", runId, "add", "--argument", '"fig"'], second.io)).toBe(0);
      expect(second.out).toEqual(["800"]);

      const rejected = captureIo(directory);
      expect(await main(["run", "update", runId, "add", "--argument", '"fig"'], rejected.io)).toBe(
        1,
      );
      expect(rejected.err.join("\n")).toContain("fig is in the cart already");

      const queried = captureIo(directory);
      expect(await main(["run", "query", runId, "items"], queried.io)).toBe(0);
      expect(queried.out).toEqual(['["apple","fig"]']);

      expect(await main(["run", "signal", runId, "checkout"], captureIo(directory).io)).toBe(0);
      const history = captureIo(directory);
      for (let attempt = 0; attempt < 400; attempt += 1) {
        history.out.length = 0;
        await main(["run", "describe", runId, "--json"], history.io);
        if ((JSON.parse(history.out[0] ?? "{}") as { status: string }).status !== "RUNNING") {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      expect(JSON.parse(history.out[0] ?? "{}")).toMatchObject({
        status: "COMPLETED",
        result: { items: ["apple", "fig"], total: 800 },
      });

      expect(
        await main(["history", "export", runId, "--out", "cart.json"], captureIo(directory).io),
      ).toBe(0);
      const replayed = captureIo(directory);
      expect(await main(["replay", "--module", cartModule, "cart.json"], replayed.io)).toBe(0);
      expect(replayed.out.at(-1)).toBe("1 passed, 0 failed");

      stop();
      expect(await running).toBe(0);
    });

    it("stops the api and the engine when the dev state cannot be written", async () => {
      await writeFile(path.join(directory, ".wf"), "not a directory");
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      await new Promise<void>((resolve) => {
        probe.close(() => {
          resolve();
        });
      });
      const dev = captureIo(directory, { DATABASE_URL: urlForSchema(database.schema) });
      const code = await main(
        ["dev", "--port", String(port), "--example", "payment-saga"],
        dev.io,
        {
          shutdown: () => new Promise<void>(() => undefined),
        },
      );
      expect(code).not.toBe(0);
      await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow();
      expect(dev.err.filter((line) => line.startsWith("engine error"))).toEqual([]);
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
