import path from "node:path";
import { describe, expect, it } from "vitest";
import { defineStep, defineWorkflow } from "@dee/core";
import { CliError } from "./errors.js";
import {
  EXAMPLE_NAMES,
  loadExample,
  loadExampleDemo,
  loadWorkflowModule,
  mergeModules,
  toWorkflowModule,
} from "./modules.js";

describe("workflow modules", () => {
  const workflow = defineWorkflow("one", (ctx) => ctx.step("one.step", {}));
  const step = defineStep("one.step", { handler: () => 1 });

  it("accepts named exports and a default export", () => {
    expect(toWorkflowModule({ workflows: [workflow], steps: [step] }, "m").workflows).toHaveLength(
      1,
    );
    expect(toWorkflowModule({ default: { workflows: [workflow] } }, "m").steps).toEqual([]);
  });

  it("names the module and the problem when the exports are wrong", () => {
    expect(() => toWorkflowModule({ workflows: [{}] }, "bad.ts")).toThrow(/bad\.ts: `workflows`/);
    expect(() => toWorkflowModule({ steps: ["x"] }, "bad.ts")).toThrow(/bad\.ts: `steps`/);
    expect(() => toWorkflowModule({}, "empty.ts")).toThrow("exports no workflows and no steps");
  });

  it("refuses two definitions of the same type", () => {
    const module = { workflows: [workflow], steps: [step] };
    expect(() => mergeModules([module, module])).toThrow(CliError);
    expect(() => mergeModules([module, module])).toThrow('workflow type "one" is defined twice');
    expect(mergeModules([module]).steps).toHaveLength(1);
  });

  it("loads a module from a file path relative to the working directory", async () => {
    const loaded = await loadWorkflowModule("fixtures/sample-module.ts", import.meta.dirname);
    expect(loaded.workflows.map((entry) => entry.workflowType)).toEqual(["sample"]);
    expect(loaded.steps.map((entry) => entry.stepType)).toEqual(["sample.shout"]);
  });

  it("reports a module that cannot be loaded", async () => {
    await expect(loadWorkflowModule("does-not-exist.ts", path.resolve("/tmp"))).rejects.toThrow(
      "cannot load does-not-exist.ts",
    );
  });

  it("loads every bundled example with workflows, steps and a demo", async () => {
    for (const name of EXAMPLE_NAMES) {
      const module = await loadExample(name);
      const demo = await loadExampleDemo(name);
      expect(module.workflows.length).toBeGreaterThan(0);
      expect(module.steps.length).toBeGreaterThan(0);
      expect(typeof demo.run).toBe("function");
    }
  });

  it("has no workflow or step type shared between the bundled examples", async () => {
    const modules = await Promise.all(EXAMPLE_NAMES.map((name) => loadExample(name)));
    expect(() => mergeModules(modules)).not.toThrow();
  });
});
