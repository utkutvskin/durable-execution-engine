import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi.js";
import { validateOpenApiDocument } from "./openapi-validator.js";
import { createRoutes } from "./routes.js";
import type { RunService } from "./run-service.js";

const unusedService = {} as RunService;
const routes = createRoutes(unusedService);
const document = buildOpenApiDocument(routes);

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
}

describe("generated openapi document", () => {
  it("passes schema validation", () => {
    expect(validateOpenApiDocument(document)).toEqual([]);
  });

  it("describes every route once, under its method and path", () => {
    const paths = document["paths"] as Record<string, Record<string, { operationId: string }>>;
    for (const route of routes) {
      expect(paths[route.path]?.[route.method]?.operationId).toBe(route.operationId);
    }
    expect(Object.values(paths).flatMap((item) => Object.keys(item))).toHaveLength(routes.length);
  });

  it("covers the seven endpoints of the product surface", () => {
    expect(routes.map((route) => route.operationId).sort()).toEqual([
      "cancelRun",
      "describeRun",
      "getHistory",
      "listRuns",
      "signalRun",
      "startRun",
      "terminateRun",
    ]);
  });

  it("requires the bearer scheme on every operation and documents the idempotency header", () => {
    const paths = document["paths"] as Record<
      string,
      Record<string, { security: unknown; parameters?: { name: string }[] }>
    >;
    for (const item of Object.values(paths)) {
      for (const operation of Object.values(item)) {
        expect(operation.security).toEqual([{ bearerAuth: [] }]);
      }
    }
    const names = paths["/v1/runs"]?.["post"]?.parameters?.map((parameter) => parameter.name);
    expect(names).toEqual(["Idempotency-Key"]);
  });

  it("documents the list filters as query parameters", () => {
    const paths = document["paths"] as Record<
      string,
      Record<string, { parameters?: { name: string; in: string; required: boolean }[] }>
    >;
    const parameters = paths["/v1/runs"]?.["get"]?.parameters ?? [];
    expect(parameters.map((parameter) => parameter.name)).toEqual([
      "status",
      "workflowType",
      "limit",
      "cursor",
    ]);
    expect(parameters.every((parameter) => parameter.in === "query")).toBe(true);
  });

  it("shares named schemas through components instead of repeating them", () => {
    const schemas = (document["components"] as { schemas: Record<string, unknown> }).schemas;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(["RunDescription", "RunSummary", "ErrorResponse", "StartRunRequest"]),
    );
  });
});

describe("openapi validator", () => {
  it("rejects a $ref that does not resolve", () => {
    const broken = JSON.stringify(document).replace(
      "#/components/schemas/ErrorResponse",
      "#/components/schemas/Missing",
    );
    expect(validateOpenApiDocument(JSON.parse(broken)).join("\n")).toContain("does not resolve");
  });

  it("rejects a wrong version, a missing info title and an empty paths object", () => {
    const broken = clone();
    broken["openapi"] = "2.0";
    broken["info"] = {};
    broken["paths"] = {};
    const errors = validateOpenApiDocument(broken);
    expect(errors).toEqual([
      "openapi must be a 3.1.x version string",
      "info needs a title and a version",
      "paths must list at least one path",
    ]);
  });

  it("rejects an operation without responses and a repeated operation id", () => {
    const broken = clone();
    const paths = broken["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    const describeOperation = paths["/v1/runs/{runId}"]?.["get"];
    const history = paths["/v1/runs/{runId}/history"]?.["get"];
    if (describeOperation === undefined || history === undefined) {
      throw new Error("fixture routes are missing");
    }
    describeOperation["responses"] = {};
    history["operationId"] = "describeRun";
    const errors = validateOpenApiDocument(broken).join("\n");
    expect(errors).toContain("responses must list at least one response");
    expect(errors).toContain('operationId "describeRun" is used twice');
  });

  it("rejects a path template parameter that is not declared", () => {
    const broken = clone();
    const paths = broken["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    const operation = paths["/v1/runs/{runId}"]?.["get"];
    if (operation === undefined) {
      throw new Error("fixture route is missing");
    }
    operation["parameters"] = [];
    expect(validateOpenApiDocument(broken).join("\n")).toContain(
      'path template parameter "runId" is not declared',
    );
  });

  it("rejects an unknown schema type and an undefined security scheme", () => {
    const broken = clone();
    const schemas = (broken["components"] as { schemas: Record<string, { type?: string }> })
      .schemas;
    const schema = schemas["SequenceResponse"];
    if (schema === undefined) {
      throw new Error("fixture schema is missing");
    }
    schema.type = "float";
    (broken["components"] as Record<string, unknown>)["securitySchemes"] = {};
    const errors = validateOpenApiDocument(broken).join("\n");
    expect(errors).toContain('unknown schema type "float"');
    expect(errors).toContain('security scheme "bearerAuth" is not defined');
  });
});
