import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidHistoryExportError } from "../replay/history-export.ts";
import {
  archiveHeaderLine,
  createDirectoryArchive,
  readRunEventArchive,
  RUN_EVENT_ARCHIVE_FORMAT,
} from "./run-event-archive.ts";

const PARTITION = {
  name: "run_events_p20300101",
  lowerBound: new Date("2030-01-01T00:00:00.000Z"),
  upperBound: new Date("2030-01-02T00:00:00.000Z"),
};
const RUN_ID = "11111111-1111-4111-8111-111111111111";

function eventLine(sequenceNumber: number, event: Record<string, unknown>): string {
  return JSON.stringify({
    runId: RUN_ID,
    sequenceNumber,
    createdAt: "2030-01-01T00:00:00.000Z",
    version: 1,
    event,
  });
}

async function* lines(...values: string[]): AsyncGenerator<string> {
  for (const value of values) {
    yield await Promise.resolve(value);
  }
}

describe("run event archives", () => {
  it("reads events in any line order back into a history in sequence order", () => {
    const text = [
      archiveHeaderLine(PARTITION, new Date("2030-02-01T00:00:00.000Z")),
      eventLine(2, { type: "run_completed", result: 1 }),
      eventLine(1, { type: "run_started", workflowType: "late", input: null }),
    ].join("\n");

    const contents = readRunEventArchive(text, "a.ndjson");

    expect(contents.partition).toBe(PARTITION.name);
    expect(contents.histories).toHaveLength(1);
    expect(contents.histories[0]).toMatchObject({ runId: RUN_ID, workflowType: "late" });
    expect(contents.histories[0]?.events.map((event) => event.event.type)).toEqual([
      "run_started",
      "run_completed",
    ]);
  });

  it("refuses an archive written by a newer format version", () => {
    const header = JSON.stringify({
      format: RUN_EVENT_ARCHIVE_FORMAT,
      formatVersion: 2,
      partition: PARTITION.name,
    });

    expect(() => readRunEventArchive(header, "new.ndjson")).toThrow(InvalidHistoryExportError);
    expect(() => readRunEventArchive(header, "new.ndjson")).toThrow(/newer than 1/);
    expect(() => readRunEventArchive("", "empty.ndjson")).toThrow(/the archive is empty/);
  });

  it("writes a complete file under its final name and leaves no partial file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dee-archive-file-"));
    try {
      const written = await createDirectoryArchive(path.join(directory, "nested")).write(
        PARTITION,
        lines("first", "second"),
      );

      expect(written).toBe(path.join(directory, "nested", `${PARTITION.name}.ndjson`));
      expect(await readFile(written, "utf8")).toBe("first\nsecond\n");
      expect(await readdir(path.join(directory, "nested"))).toEqual([`${PARTITION.name}.ndjson`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
