import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveHeaderLine, parseHistoryExport } from "@dee/core";
import type { CliIo } from "../io.ts";
import { main } from "../main.ts";
import type { HistoryItem, RunClient } from "../run-client.ts";

const RUN_ID = "22222222-2222-4222-8222-222222222222";

const sampleHistory: readonly HistoryItem[] = [
  {
    sequenceNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    event: { type: "run_started", workflowType: "sample", input: {} },
  },
  {
    sequenceNumber: 2,
    createdAt: "2026-01-01T00:00:00.100Z",
    version: 1,
    event: { type: "step_scheduled", stepId: "step-1", stepType: "sample.shout", input: {} },
  },
  {
    sequenceNumber: 3,
    createdAt: "2026-01-01T00:00:00.200Z",
    version: 1,
    event: { type: "step_completed", stepId: "step-1", result: "HELLO" },
  },
  {
    sequenceNumber: 4,
    createdAt: "2026-01-01T00:00:00.300Z",
    version: 1,
    event: {
      type: "timer_started",
      timerId: "timer-1",
      fireAt: "2026-01-01T00:00:01.300Z",
      durationMs: 1000,
    },
  },
];

function historyClient(history: readonly HistoryItem[]): RunClient {
  const unused = (): Promise<never> => Promise.reject(new Error("not used"));
  return {
    start: unused,
    signal: unused,
    update: unused,
    query: unused,
    cancel: unused,
    describe: unused,
    listRuns: unused,
    waitForClose: unused,
    history: (runId) =>
      runId === RUN_ID ? Promise.resolve(history) : Promise.reject(new Error("unknown run")),
  };
}

function captureIo(cwd: string): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), env: {}, cwd },
  };
}

const fixtures = path.join(import.meta.dirname, "..", "fixtures");
const exportedAt = new Date("2026-02-01T00:00:00.000Z");

describe("wf history export and wf replay", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "wf-replay-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function exportTo(file: string, history = sampleHistory): Promise<void> {
    const { io } = captureIo(directory);
    const code = await main(["history", "export", RUN_ID, "--out", file], io, {
      client: historyClient(history),
      now: () => exportedAt,
    });
    expect(code).toBe(0);
  }

  it("prints the run's history as an export that core reads back", async () => {
    const { io, out } = captureIo(directory);
    expect(
      await main(["history", "export", RUN_ID], io, {
        client: historyClient(sampleHistory),
        now: () => exportedAt,
      }),
    ).toBe(0);
    const exported = JSON.parse(out.join("\n")) as unknown;
    expect(exported).toMatchObject({
      format: "dee.history",
      formatVersion: 1,
      runId: RUN_ID,
      workflowType: "sample",
      exportedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(parseHistoryExport(exported).events).toHaveLength(4);
  });

  it("writes the export to --out relative to the working directory", async () => {
    await exportTo("sample.json");
    const written = JSON.parse(await readFile(path.join(directory, "sample.json"), "utf8")) as {
      events: unknown[];
    };
    expect(written.events).toHaveLength(4);
  });

  it("refuses to export a compacted history", async () => {
    const { io, err } = captureIo(directory);
    const code = await main(["history", "export", RUN_ID], io, {
      client: historyClient(sampleHistory.slice(2)),
    });
    expect(code).toBe(1);
    expect(err[0]).toMatch(/compacted run cannot be exported/);
  });

  it("rejects an unknown history action and a missing run id as usage errors", async () => {
    const client = historyClient(sampleHistory);
    expect(await main(["history", "purge", RUN_ID], captureIo(directory).io, { client })).toBe(2);
    expect(await main(["history", "export"], captureIo(directory).io, { client })).toBe(2);
  });

  async function writeArchive(file: string, runs: Record<string, readonly HistoryItem[]>) {
    const header = archiveHeaderLine(
      {
        name: "run_events_p20260101",
        lowerBound: new Date("2026-01-01T00:00:00.000Z"),
        upperBound: new Date("2026-01-02T00:00:00.000Z"),
      },
      exportedAt,
    );
    const lines = Object.entries(runs).flatMap(([runId, events]) =>
      events.map((item) => JSON.stringify({ runId, ...item })),
    );
    await writeFile(path.join(directory, file), `${[header, ...lines].join("\n")}\n`, "utf8");
  }

  it("imports an archive into one export per run that wf replay replays", async () => {
    await writeArchive("partition.ndjson", { [RUN_ID]: [...sampleHistory].reverse() });
    const imported = captureIo(directory);
    expect(
      await main(["history", "import", "partition.ndjson", "--out", "histories"], imported.io, {
        now: () => exportedAt,
      }),
    ).toBe(0);
    expect(imported.out).toEqual([
      "imported 1 runs of run_events_p20260101 from partition.ndjson to histories",
    ]);
    const file = path.join("histories", `${RUN_ID}.json`);
    const written = JSON.parse(await readFile(path.join(directory, file), "utf8")) as unknown;
    expect(parseHistoryExport(written).events.map((event) => event.sequenceNumber)).toEqual([
      1, 2, 3, 4,
    ]);

    const replayed = captureIo(directory);
    const code = await main(
      ["replay", "--module", path.join(fixtures, "replay-module.ts"), file],
      replayed.io,
    );
    expect(code).toBe(0);
    expect(replayed.out).toEqual([
      `ok    run ${RUN_ID} (${file}): 4 events replayed`,
      "1 passed, 0 failed",
    ]);
  });

  it("skips a compacted run of an archive and names it on stderr", async () => {
    const compacted = "33333333-3333-4333-8333-333333333333";
    await writeArchive("partition.ndjson", {
      [RUN_ID]: sampleHistory,
      [compacted]: sampleHistory.slice(2),
    });
    const { io, out, err } = captureIo(directory);
    expect(await main(["history", "import", "partition.ndjson", "--out", "h"], io)).toBe(0);
    expect(err).toEqual([
      expect.stringMatching(new RegExp(`^skipped run ${compacted}: .*compacted run cannot`)),
    ]);
    expect(out).toEqual(["imported 1 runs of run_events_p20260101 from partition.ndjson to h"]);
  });

  it("refuses an import without --out and a file that is not an archive", async () => {
    await writeFile(path.join(directory, "plain.ndjson"), '{"hello":"world"}\n', "utf8");
    expect(await main(["history", "import", "plain.ndjson"], captureIo(directory).io)).toBe(2);
    const { io, err } = captureIo(directory);
    expect(await main(["history", "import", "plain.ndjson", "--out", "h"], io)).toBe(1);
    expect(err[0]).toMatch(/^error: plain\.ndjson: not a run event archive/);
  });

  it("replays an export against the code that wrote it and exits 0", async () => {
    await exportTo("sample.json");
    const { io, out } = captureIo(directory);
    const code = await main(
      ["replay", "--module", path.join(fixtures, "replay-module.ts"), "sample.json"],
      io,
    );
    expect(code).toBe(0);
    expect(out).toEqual([
      `ok    run ${RUN_ID} (sample.json): 4 events replayed`,
      "1 passed, 0 failed",
    ]);
  });

  it("exits 1 naming the run and the event when the code is not deterministic", async () => {
    await exportTo("sample.json");
    const { io, out, err } = captureIo(directory);
    const code = await main(
      ["replay", "--module", path.join(fixtures, "sample-module.ts"), "sample.json"],
      io,
    );
    expect(code).toBe(1);
    expect(err).toEqual([
      expect.stringMatching(
        new RegExp(
          `^FAIL  run ${RUN_ID} \\(sample\\.json\\): non determinism at event 4 \\(timer_started\\): `,
        ),
      ),
    ]);
    expect(out).toEqual(["0 passed, 1 failed"]);
  });

  it("reports every file, an unreadable one included, and prints json with --json", async () => {
    await exportTo("good.json");
    await writeFile(path.join(directory, "bad.json"), "{ not json", "utf8");
    const { io, out } = captureIo(directory);
    const code = await main(
      [
        "replay",
        "--json",
        "--module",
        path.join(fixtures, "replay-module.ts"),
        "good.json",
        "bad.json",
      ],
      io,
    );
    expect(code).toBe(1);
    const report = JSON.parse(out[0] ?? "{}") as {
      passed: number;
      failed: number;
      results: { source: string; problem?: { kind: string } }[];
    };
    expect(report).toMatchObject({ passed: 1, failed: 1 });
    expect(report.results.map((result) => [result.source, result.problem?.kind])).toEqual([
      ["good.json", undefined],
      ["bad.json", "invalid_history"],
    ]);
  });

  it("needs history files and workflows", async () => {
    expect(
      await main(
        ["replay", "--module", path.join(fixtures, "replay-module.ts")],
        captureIo(directory).io,
      ),
    ).toBe(2);
    await exportTo("sample.json");
    expect(await main(["replay", "sample.json"], captureIo(directory).io)).toBe(2);
    expect(
      await main(
        ["replay", "--module", path.join(fixtures, "replay-module.ts"), "missing.json"],
        captureIo(directory).io,
      ),
    ).toBe(1);
  });
});
