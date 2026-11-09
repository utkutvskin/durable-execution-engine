import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createIsolatedDatabase,
  createIsolatedSchema,
  type IsolatedSchema,
} from "../../core/src/db/test-harness.ts";
import type { DatabaseEffects } from "./database.ts";
import type { CliIo } from "./io.ts";
import { main } from "./main.ts";
import { urlForSchema } from "./test-support.ts";

interface Captured {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(
  cwd: string,
  env: Record<string, string | undefined>,
  confirm?: (question: string) => Promise<boolean>,
): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      env,
      cwd,
      ...(confirm === undefined ? {} : { confirm }),
    },
  };
}

interface RunningCommand {
  readonly captured: Captured;
  stop(): Promise<number>;
}

function startCommand(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): RunningCommand {
  const captured = capture(cwd, env);
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = main(args, captured.io, { shutdown: () => released });
  return {
    captured,
    async stop(): Promise<number> {
      release();
      return running;
    },
  };
}

async function waitForLine(
  command: RunningCommand,
  predicate: (line: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = command.captured.out.find(predicate);
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no matching line; out: ${command.captured.out.join(" | ")}; err: ${command.captured.err.join(" | ")}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function logLine(message: string): (line: string) => boolean {
  return (line) => {
    try {
      return (JSON.parse(line) as { message?: string }).message === message;
    } catch {
      return false;
    }
  };
}

const KEY = "dee_production-test-key-000001";

describe("production commands", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "wf-production-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe("migrate down confirmation", () => {
    let schema: IsolatedSchema;
    let env: Record<string, string>;

    beforeEach(async () => {
      schema = await createIsolatedSchema();
      env = { DATABASE_URL: urlForSchema(schema.schema) };
      expect(await main(["migrate"], capture(directory, env).io)).toBe(0);
    });

    afterEach(async () => {
      await schema.close();
    });

    async function appliedCount(): Promise<number> {
      const rows = await schema.pool.query("select 1 from schema_migrations");
      return rows.rowCount ?? 0;
    }

    it("refuses to revert without a terminal and without --yes", async () => {
      const before = await appliedCount();
      const run = capture(directory, env);
      expect(await main(["migrate", "down"], run.io)).toBe(2);
      expect(run.err.join("\n")).toContain("--yes");
      expect(await appliedCount()).toBe(before);
    });

    it("reverts nothing when the answer is no", async () => {
      const before = await appliedCount();
      const run = capture(directory, env, () => Promise.resolve(false));
      expect(await main(["migrate", "down"], run.io)).toBe(1);
      expect(run.out).toEqual(["aborted, nothing was reverted"]);
      expect(await appliedCount()).toBe(before);
    });

    it("reverts one migration when the answer is yes and names the database without its password", async () => {
      const before = await appliedCount();
      const questions: string[] = [];
      const run = capture(directory, env, (question) => {
        questions.push(question);
        return Promise.resolve(true);
      });
      expect(await main(["migrate", "down"], run.io)).toBe(0);
      expect(await appliedCount()).toBe(before - 1);
      expect(questions).toHaveLength(1);
      expect(questions[0]).toContain("revert the last 1 migration(s)");
      expect(questions[0]).not.toContain("@");
    });

    it("never asks when --yes is given", async () => {
      const before = await appliedCount();
      const run = capture(directory, env, () => Promise.reject(new Error("must not ask")));
      expect(await main(["migrate", "down", "--yes"], run.io)).toBe(0);
      expect(await appliedCount()).toBe(before - 1);
    });
  });

  describe("compose in production", () => {
    function unreachable(): { effects: DatabaseEffects; composeStarts: string[] } {
      const composeStarts: string[] = [];
      return {
        composeStarts,
        effects: {
          reachable: () => Promise.resolve(false),
          startCompose: (composeDirectory) => {
            composeStarts.push(composeDirectory);
            return Promise.resolve(1);
          },
          pause: () => Promise.resolve(),
        },
      };
    }

    for (const command of [["worker", "--example", "payment-saga"], ["migrate"], ["serve"]]) {
      it(`wf ${command[0] ?? ""} never starts compose when NODE_ENV is production`, async () => {
        const probe = unreachable();
        const run = capture(process.cwd(), {
          NODE_ENV: "production",
          DATABASE_URL: "postgres://nobody:secret@127.0.0.1:1/none",
        });
        expect(await main(command, run.io, { databaseEffects: probe.effects })).toBe(1);
        expect(probe.composeStarts).toEqual([]);
        expect(run.err.join("\n")).toContain("NODE_ENV=production");
      });
    }

    it("wf worker still starts compose outside production", async () => {
      const probe = unreachable();
      const run = capture(process.cwd(), {
        DATABASE_URL: "postgres://nobody:secret@127.0.0.1:1/none",
      });
      await main(["worker", "--example", "payment-saga"], run.io, {
        databaseEffects: probe.effects,
      });
      expect(probe.composeStarts).toHaveLength(1);
    });
  });

  describe("wf serve", () => {
    let database: IsolatedSchema;
    let env: Record<string, string>;

    beforeAll(async () => {
      database = await createIsolatedDatabase();
      env = { DATABASE_URL: urlForSchema(database.schema) };
    });

    afterAll(async () => {
      await database.close();
    });

    beforeEach(async () => {
      await database.pool.query("truncate namespaces cascade");
    });

    it("answers requests with the key from WF_API_KEY and logs structured json", async () => {
      const serve = startCommand(["serve", "--port", "0", "--host", "127.0.0.1"], directory, {
        ...env,
        WF_API_KEY: KEY,
      });
      const started = JSON.parse(await waitForLine(serve, logLine("api listening"))) as {
        url: string;
        keySource: string;
        level: string;
        service: string;
      };
      expect(started).toMatchObject({ keySource: "adopted", level: "info", service: "wf-serve" });
      const listed = await fetch(`${started.url}/v1/runs`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(listed.status).toBe(200);
      expect((await fetch(`${started.url}/v1/runs`)).status).toBe(401);
      expect(serve.captured.out.some(logLine("issued a new api key, it is shown once"))).toBe(
        false,
      );
      expect(serve.captured.out.every((line) => JSON.parse(line) !== null)).toBe(true);
      expect(await serve.stop()).toBe(0);
    });

    it("issues a key once for a namespace without one and keeps it on the next start", async () => {
      const first = startCommand(["serve", "--port", "0", "--host", "127.0.0.1"], directory, env);
      await waitForLine(first, logLine("api listening"));
      const issued = JSON.parse(
        await waitForLine(first, logLine("issued a new api key, it is shown once")),
      ) as { apiKey: string };
      expect(issued.apiKey.startsWith("dee_")).toBe(true);
      expect(await first.stop()).toBe(0);

      const second = startCommand(["serve", "--port", "0", "--host", "127.0.0.1"], directory, env);
      const started = JSON.parse(await waitForLine(second, logLine("api listening"))) as {
        keySource: string;
        url: string;
      };
      expect(started.keySource).toBe("existing");
      expect(second.captured.out.some(logLine("issued a new api key, it is shown once"))).toBe(
        false,
      );
      const stillValid = await fetch(`${started.url}/v1/runs`, {
        headers: { authorization: `Bearer ${issued.apiKey}` },
      });
      expect(stillValid.status).toBe(200);
      expect(await second.stop()).toBe(0);
    });

    it("writes text lines with --log-format text", async () => {
      const serve = startCommand(
        ["serve", "--port", "0", "--host", "127.0.0.1", "--log-format", "text"],
        directory,
        { ...env, WF_API_KEY: KEY },
      );
      const line = await waitForLine(serve, (entry) => entry.includes("api listening"));
      expect(line).toMatch(
        /^\d{4}-\d{2}-\d{2}T\S+ INFO\s+api listening service=wf-serve url=http:\/\/127\.0\.0\.1:/,
      );
      expect(await serve.stop()).toBe(0);
    });

    it("applies the quota flags to its namespace and protects /metrics with a token", async () => {
      const serve = startCommand(
        [
          "serve",
          "--port",
          "0",
          "--host",
          "127.0.0.1",
          "--namespace",
          "limited",
          "--max-concurrent-runs",
          "7",
          "--rate-per-second",
          "50",
          "--burst",
          "80",
          "--metrics-token",
          "scrape",
        ],
        directory,
        { ...env, WF_API_KEY: KEY },
      );
      const started = JSON.parse(await waitForLine(serve, logLine("api listening"))) as {
        url: string;
      };
      const quota = await database.pool.query<{
        max_concurrent_runs: number;
        rate_per_second: number;
        burst: number;
        max_pending_tasks: number | null;
      }>(
        `select q.* from namespace_quotas q join namespaces n on n.id = q.namespace_id
         where n.name = 'limited'`,
      );
      expect(quota.rows[0]).toMatchObject({
        max_concurrent_runs: 7,
        rate_per_second: 50,
        burst: 80,
        max_pending_tasks: null,
      });
      expect((await fetch(`${started.url}/metrics`)).status).toBe(401);
      const scraped = await fetch(`${started.url}/metrics`, {
        headers: { authorization: "Bearer scrape" },
      });
      expect(scraped.status).toBe(200);
      expect(await serve.stop()).toBe(0);
    });

    it("refuses to start on a schema that is behind and migrates with --migrate", async () => {
      const behind = await createIsolatedSchema();
      try {
        const behindEnv = { DATABASE_URL: urlForSchema(behind.schema), WF_API_KEY: KEY };
        const refused = capture(directory, behindEnv);
        expect(await main(["serve", "--port", "0"], refused.io)).toBe(1);
        expect(refused.err.join("\n")).toContain("wf migrate up");
        const serve = startCommand(
          ["serve", "--port", "0", "--host", "127.0.0.1", "--migrate"],
          directory,
          behindEnv,
        );
        await waitForLine(serve, logLine("api listening"));
        expect(await serve.stop()).toBe(0);
      } finally {
        await behind.close();
      }
    });

    it("rejects a malformed WF_API_KEY and bad flags with a usage error", async () => {
      const bad = capture(directory, { ...env, WF_API_KEY: "short" });
      expect(await main(["serve", "--port", "0"], bad.io)).toBe(1);
      expect(bad.err.join("\n")).toContain("api key");
      for (const flags of [
        ["--log-level", "loud"],
        ["--log-format", "xml"],
        ["--pool-size", "0"],
        ["--burst", "10"],
        ["--sampling-ratio", "2"],
        ["--max-queue-depth", "-1"],
      ]) {
        const run = capture(directory, env);
        expect(await main(["serve", ...flags], run.io), flags.join(" ")).toBe(2);
      }
    });
  });

  describe("wf worker", () => {
    let database: IsolatedSchema;
    let env: Record<string, string>;

    beforeAll(async () => {
      database = await createIsolatedDatabase();
      env = { DATABASE_URL: urlForSchema(database.schema) };
    });

    afterAll(async () => {
      await database.close();
    });

    it("serves health and metrics on --health-port and logs where", async () => {
      const worker = startCommand(
        ["worker", "--example", "payment-saga", "--health-port", "0", "--health-host", "127.0.0.1"],
        directory,
        env,
      );
      const started = JSON.parse(await waitForLine(worker, logLine("worker running"))) as {
        opsPort: number;
        workerId: string;
        queue: string;
      };
      const base = `http://127.0.0.1:${String(started.opsPort)}`;
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      const metrics = await (await fetch(`${base}/metrics`)).text();
      for (const name of ["dee_queue_depth", "dee_runs", "dee_active_workers"]) {
        expect(metrics).toContain(name);
      }
      expect(await worker.stop()).toBe(0);
      await expect(fetch(`${base}/health`)).rejects.toThrow();
    });

    it("compacts closed runs on the schedule given by the flags", async () => {
      const namespace = await database.pool.query<{ id: string }>(
        `insert into namespaces (name) values ('compaction')
         on conflict (name) do update set name = excluded.name returning id`,
      );
      const closed = await database.pool.query<{ id: string }>(
        `insert into workflow_runs (namespace_id, workflow_type, status, closed_at)
         values ($1, 'ghost', 'COMPLETED', now() - interval '1 hour') returning id`,
        [namespace.rows[0]?.id],
      );
      const runId = closed.rows[0]?.id ?? "";
      await database.pool.query(
        `insert into run_events (run_id, sequence_number, event_type, payload)
         values ($1, 1, 'run_started', '{"type":"run_started","workflowType":"ghost","input":null}')`,
        [runId],
      );
      const worker = startCommand(
        [
          "worker",
          "--example",
          "payment-saga",
          "--compact-interval",
          "1",
          "--compact-retention",
          "60",
          "--compact-tail-events",
          "0",
        ],
        directory,
        env,
      );
      await waitForLine(worker, logLine("worker running"));
      const deadline = Date.now() + 10_000;
      let snapshots = 0;
      while (snapshots === 0 && Date.now() < deadline) {
        const rows = await database.pool.query("select 1 from run_snapshots where run_id = $1", [
          runId,
        ]);
        snapshots = rows.rowCount ?? 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      expect(snapshots).toBe(1);
      expect(await worker.stop()).toBe(0);
    });

    it("rejects compaction detail flags without an interval and bad numbers", async () => {
      for (const flags of [
        ["--compact-retention", "60"],
        ["--compact-tail-events", "5"],
        ["--concurrency", "0"],
        ["--health-port", "70000"],
        ["--pool-size", "ten"],
      ]) {
        const run = capture(directory, env);
        expect(await main(["worker", "--example", "payment-saga", ...flags], run.io)).toBe(2);
      }
    });

    it("reads flags from WF_ environment variables", async () => {
      const run = capture(directory, { ...env, WF_POOL_SIZE: "0" });
      expect(await main(["worker", "--example", "payment-saga"], run.io)).toBe(2);
      expect(run.err.join("\n")).toContain("--pool-size");
    });
  });
});
