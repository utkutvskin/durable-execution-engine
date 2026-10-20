import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyStepDefinition, AnyWorkflowDefinition } from "@dee/worker";
import type { ScheduleManager } from "@dee/core";
import { CliError } from "./errors.js";
import type { RunClient } from "./run-client.js";

/**
 * The workflows and steps a module contributes to a worker.
 */
export interface WorkflowModule {
  readonly workflows: readonly AnyWorkflowDefinition[];
  readonly steps: readonly AnyStepDefinition[];
}

/**
 * The example applications that ship with the repository, by the name
 * `wf dev --example` and `wf example` take.
 */
export const EXAMPLE_NAMES = ["payment-saga", "etl-pipeline"] as const;

/**
 * One of `EXAMPLE_NAMES`.
 */
export type ExampleName = (typeof EXAMPLE_NAMES)[number];

function isDefinition(value: unknown, key: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[key] === "string" &&
    typeof (value as Record<string, unknown>)["handler"] === "function"
  );
}

/**
 * Checks that `candidate` has a `workflows` array of workflow definitions and
 * a `steps` array of step definitions (either may be missing and counts as
 * empty). `source` names the module in the error message.
 */
export function toWorkflowModule(candidate: unknown, source: string): WorkflowModule {
  const record = (candidate ?? {}) as Record<string, unknown>;
  const holder =
    typeof record["default"] === "object" && record["default"] !== null
      ? (record["default"] as Record<string, unknown>)
      : record;
  const workflows = (holder["workflows"] ?? []) as unknown;
  const steps = (holder["steps"] ?? []) as unknown;
  if (
    !Array.isArray(workflows) ||
    !workflows.every((entry) => isDefinition(entry, "workflowType"))
  ) {
    throw new CliError(
      `${source}: \`workflows\` must be an array of definitions made with defineWorkflow`,
    );
  }
  if (!Array.isArray(steps) || !steps.every((entry) => isDefinition(entry, "stepType"))) {
    throw new CliError(`${source}: \`steps\` must be an array of definitions made with defineStep`);
  }
  if (workflows.length === 0 && steps.length === 0) {
    throw new CliError(`${source}: the module exports no workflows and no steps`);
  }
  return {
    workflows: workflows as AnyWorkflowDefinition[],
    steps: steps as AnyStepDefinition[],
  };
}

/**
 * Imports the module at `specifier` (a path relative to `cwd`, or an absolute
 * path) and returns the workflows and steps it exports.
 */
export async function loadWorkflowModule(specifier: string, cwd: string): Promise<WorkflowModule> {
  const url = pathToFileURL(path.resolve(cwd, specifier)).href;
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch (error) {
    throw new CliError(
      `cannot load ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return toWorkflowModule(loaded, specifier);
}

/**
 * Loads one of the bundled examples.
 */
export async function loadExample(name: ExampleName): Promise<WorkflowModule> {
  const loaded: unknown =
    name === "payment-saga"
      ? await import("@dee/example-payment-saga")
      : await import("@dee/example-etl-pipeline");
  return toWorkflowModule(loaded, `example ${name}`);
}

/**
 * What a bundled example's scenarios get to work with.
 */
export interface DemoContext {
  readonly client: RunClient;
  readonly schedules: ScheduleManager;
  readonly namespaceId: string;
  readonly log: (line: string) => void;
}

/**
 * What a scenario run reports: whether every scenario ended as expected and,
 * when not, what went wrong.
 */
export interface DemoReport {
  readonly ok: boolean;
  readonly problem?: string;
}

/**
 * A bundled example: the workflows and steps it needs and the scenarios that
 * show it working.
 */
export interface ExampleDemo {
  readonly description: string;
  readonly module: WorkflowModule;
  readonly run: (context: DemoContext) => Promise<DemoReport>;
}

/**
 * Loads the module and the scenarios of a bundled example.
 */
export async function loadExampleDemo(name: ExampleName): Promise<ExampleDemo> {
  const loaded: unknown =
    name === "payment-saga"
      ? await import("@dee/example-payment-saga")
      : await import("@dee/example-etl-pipeline");
  const demo = (loaded as { demo?: Omit<ExampleDemo, "module"> }).demo;
  if (demo === undefined) {
    throw new CliError(`example ${name} exports no demo`);
  }
  return { ...demo, module: toWorkflowModule(loaded, `example ${name}`) };
}

/**
 * Merges modules into one set of definitions. Two definitions of the same
 * workflow or step type are an error, because the worker could only run one.
 */
export function mergeModules(modules: readonly WorkflowModule[]): WorkflowModule {
  const workflows = new Map<string, AnyWorkflowDefinition>();
  const steps = new Map<string, AnyStepDefinition>();
  for (const module of modules) {
    for (const workflow of module.workflows) {
      if (workflows.has(workflow.workflowType)) {
        throw new CliError(`workflow type "${workflow.workflowType}" is defined twice`);
      }
      workflows.set(workflow.workflowType, workflow);
    }
    for (const step of module.steps) {
      if (steps.has(step.stepType)) {
        throw new CliError(`step type "${step.stepType}" is defined twice`);
      }
      steps.set(step.stepType, step);
    }
  }
  return { workflows: [...workflows.values()], steps: [...steps.values()] };
}
