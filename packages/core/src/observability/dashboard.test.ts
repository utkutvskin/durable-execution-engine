import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_METRIC_NAMES } from "./engine-metrics.js";

interface Dashboard {
  readonly uid: string;
  readonly panels: readonly {
    readonly id: number;
    readonly targets: readonly { expr: string }[];
  }[];
}

const path = fileURLToPath(new URL("../../../../docs/grafana/dee-overview.json", import.meta.url));
const dashboard = JSON.parse(readFileSync(path, "utf8")) as Dashboard;
const expressions = dashboard.panels.flatMap((panel) => panel.targets.map((target) => target.expr));

describe("example grafana dashboard", () => {
  it("is a dashboard with uniquely numbered panels", () => {
    expect(dashboard.uid).toBe("dee-overview");
    const ids = dashboard.panels.map((panel) => panel.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(8);
  });

  it("charts every engine metric", () => {
    for (const name of ENGINE_METRIC_NAMES) {
      const base = name.replace(/_total$/, "");
      expect(
        expressions.some((expr) => expr.includes(base)),
        name,
      ).toBe(true);
    }
  });

  it("queries only metrics the engine exports", () => {
    const known = new Set<string>(ENGINE_METRIC_NAMES);
    const used = expressions.flatMap((expr) => expr.match(/dee_[a-z_]+/g) ?? []);
    for (const name of used) {
      const family = name.replace(/_(bucket|sum|count)$/, "");
      expect(known.has(name) || known.has(family), name).toBe(true);
    }
  });
});
