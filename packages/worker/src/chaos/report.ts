import { INVARIANT_NAMES, type InvariantName } from "@dee/core";
import type { ChaosScenario, RepetitionResult } from "./scenarios.js";

const INVARIANT_TEXT: Record<InvariantName, string> = {
  "run-terminal-or-advancing":
    "A run is either terminal or has something that will move it: an open task, a pending timer, an open dead letter or a running child.",
  "task-not-lost":
    "A task that was enqueued still exists, a leased task carries a lease token, and an acked step task left its step an outcome, a failed attempt or a dead letter.",
  "step-result-written-once":
    "A step has at most one terminal event and one stored result, and every stored result has its event.",
  "projection-consistent":
    "The run row equals the fold of the event log up to its own sequence number, never runs ahead of the log, and is terminal whenever the log is.",
  "timer-fired-once":
    "A timer has at most one fired event, a fired timer has its event, and no timer fires before it is due.",
};

const WORKLOAD_CHECKS: readonly (readonly [string, string])[] = [
  ["workload-converged", "Every run reached a terminal state before the deadline."],
  ["workload-result", "Every run completed with the result its inputs determine."],
  ["ack-accepted-once", "A task that was delivered several times accepted one ack."],
  ["fault-injected", "The repetition really injected a fault."],
  ["scenario-error", "The harness itself did not fail."],
];

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function forScenario(results: readonly RepetitionResult[], name: string): RepetitionResult[] {
  return results.filter((result) => result.scenario === name);
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/**
 * Renders the markdown of `docs/CHAOS_REPORT.md` from the results of a chaos
 * suite run. The report states the verdict first, then one row per scenario,
 * the invariants and checks behind the verdict, what each scenario injects
 * and how faithfully, and every violation in full.
 */
export function renderChaosReport(
  scenarios: readonly ChaosScenario[],
  results: readonly RepetitionResult[],
): string {
  const violations = results.flatMap((result) =>
    result.violations.map((violation) => ({ result, violation })),
  );
  const lines: string[] = [
    "# Chaos report",
    "",
    "This report is written by the chaos suite (`packages/worker/src/chaos/chaos-suite.integration.test.ts`). Each scenario injects one kind of failure into a real Postgres, lets the engine recover, and then runs the invariant checker over every run, task, step result, timer and projection the repetition touched.",
    "",
    "Regenerate it with:",
    "",
    "```sh",
    "DEE_CHAOS_REPORT=docs/CHAOS_REPORT.md pnpm exec vitest run packages/worker/src/chaos/chaos-suite.integration.test.ts",
    "pnpm exec prettier --write docs/CHAOS_REPORT.md",
    "```",
    "",
    "## Result",
    "",
    `${String(results.length)} repetitions across ${String(scenarios.length)} scenarios, ${String(violations.length)} invariant violations.`,
    "",
    "| Scenario | Repetitions | Runs | Faults injected | Task redeliveries | Errors survived | Violations | Slowest repetition |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of scenarios) {
    const own = forScenario(results, scenario.name);
    lines.push(
      `| ${scenario.title} | ${String(own.length)} | ${String(sum(own.map((entry) => entry.runs)))} | ${String(sum(own.map((entry) => entry.faults)))} | ${String(sum(own.map((entry) => entry.redeliveries)))} | ${String(sum(own.map((entry) => entry.survivedErrors)))} | ${String(sum(own.map((entry) => entry.violations.length)))} | ${String(Math.max(0, ...own.map((entry) => entry.durationMs)))} ms |`,
    );
  }
  lines.push("", "## Invariants", "");
  for (const name of INVARIANT_NAMES) {
    lines.push(`- \`${name}\`: ${INVARIANT_TEXT[name]}`);
  }
  lines.push("", "The suite also reports these checks of its own:", "");
  for (const [name, text] of WORKLOAD_CHECKS) {
    lines.push(`- \`${name}\`: ${text}`);
  }
  lines.push("", "## Scenarios", "");
  for (const scenario of scenarios) {
    const own = forScenario(results, scenario.name);
    const seeds = own.map((entry) => entry.seed);
    lines.push(
      `### ${scenario.title}`,
      "",
      scenario.injection,
      "",
      `Fidelity: ${scenario.fidelity}`,
      "",
      `Seeds: ${seeds.length === 0 ? "none" : `${String(Math.min(...seeds))} to ${String(Math.max(...seeds))}`}.`,
      "",
    );
  }
  lines.push("## Violations", "");
  if (violations.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      "| Scenario | Repetition | Seed | Check | Run | Detail |",
      "| --- | ---: | ---: | --- | --- | --- |",
    );
    for (const { result, violation } of violations) {
      lines.push(
        `| ${result.scenario} | ${String(result.repetition)} | ${String(result.seed)} | ${violation.check} | ${violation.runId ?? "-"} | ${escapeCell(violation.detail)} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Limits",
    "",
    "- Zero violations over ten repetitions is evidence, not proof. The workloads are small (the sample flow and a timer flow) and the fault points are the ones the harness knows about.",
    "- The invariant checker treats a running run with nothing to wait for as stalled, so the suite cannot park runs on signals.",
    "- Slow disk and network latency are simulated in front of Postgres, not inside it. A real fsync stall, a full disk or a restarted server are not covered.",
    "- Timings depend on the machine; the faults are seeded, the interleaving of the operating system scheduler is not.",
    "",
  );
  return lines.join("\n");
}
