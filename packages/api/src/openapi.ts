import { z } from "zod";
import { errorResponseSchema, type Route } from "./routes.js";

/**
 * A JSON object as it appears in the generated OpenAPI document.
 */
export type JsonObject = Record<string, unknown>;

/**
 * Options for `buildOpenApiDocument`.
 */
export interface OpenApiOptions {
  readonly title?: string;
  readonly version?: string;
}

const REF_PREFIX = "#/components/schemas/";

function generate(schema: z.ZodType, io: "input" | "output"): JsonObject {
  return z.toJSONSchema(schema, { io, target: "draft-2020-12", unrepresentable: "any" });
}

function jsonSchemaOf(schema: z.ZodType, io: "input" | "output"): JsonObject {
  const generated = generate(schema, io);
  delete generated["$schema"];
  return generated;
}

function collectNamed(
  schema: z.ZodType,
  io: "input" | "output",
  components: Record<string, JsonObject>,
): JsonObject {
  const generated = generate(schema, io);
  const rewritten = JSON.parse(
    JSON.stringify(generated).replaceAll("#/$defs/", REF_PREFIX),
  ) as JsonObject;
  const definitions = (rewritten["$defs"] ?? {}) as Record<string, JsonObject>;
  for (const [name, definition] of Object.entries(definitions)) {
    components[name] = definition;
  }
  delete rewritten["$schema"];
  delete rewritten["$defs"];
  return rewritten;
}

/**
 * Generates the OpenAPI 3.1 document describing `routes`, from the same zod
 * schemas the handlers validate with.
 */
export function buildOpenApiDocument(
  routes: readonly Route[],
  options: OpenApiOptions = {},
): JsonObject {
  const components: Record<string, JsonObject> = {};
  const paths: Record<string, Record<string, JsonObject>> = {};

  for (const route of routes) {
    const parameters: JsonObject[] = [];
    for (const name of route.path.matchAll(/\{(\w+)\}/g)) {
      parameters.push({
        name: name[1],
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      });
    }
    if (route.query !== undefined) {
      const querySchema = jsonSchemaOf(route.query, "input");
      const properties = (querySchema["properties"] ?? {}) as Record<string, JsonObject>;
      const required = (querySchema["required"] ?? []) as string[];
      for (const [name, schema] of Object.entries(properties)) {
        parameters.push({ name, in: "query", required: required.includes(name), schema });
      }
    }
    for (const header of route.headerParameters) {
      parameters.push({
        name: header.name,
        in: "header",
        required: false,
        description: header.description,
        schema: { type: "string", minLength: 1, maxLength: 255 },
      });
    }

    const responses: Record<string, JsonObject> = {};
    for (const [status, spec] of Object.entries(route.responses)) {
      responses[status] = {
        description: spec.description,
        ...(spec.schema === undefined
          ? {}
          : {
              content: {
                "application/json": { schema: collectNamed(spec.schema, "output", components) },
              },
            }),
      };
    }

    const operation: JsonObject = {
      operationId: route.operationId,
      summary: route.summary,
      security: [{ bearerAuth: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: collectNamed(route.body, "input", components) },
              },
            },
          }),
      responses,
    };
    const pathItem = paths[route.path] ?? {};
    pathItem[route.method] = operation;
    paths[route.path] = pathItem;
  }

  components["ErrorResponse"] ??= collectNamed(errorResponseSchema, "output", components);

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "Durable execution engine api",
      version: options.version ?? "0.1.0",
    },
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "An api key issued for one namespace. Every endpoint is scoped to it.",
        },
      },
    },
  };
}
