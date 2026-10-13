import type { JsonObject } from "./openapi.js";

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
const STATUS_PATTERN = /^([1-5]\d\d|default)$/;
const PARAMETER_LOCATIONS = new Set(["path", "query", "header", "cookie"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePointer(document: JsonObject, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = document;
  for (const segment of ref.slice(2).split("/")) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current;
}

function checkSchema(document: JsonObject, schema: unknown, where: string, errors: string[]): void {
  if (typeof schema === "boolean") {
    return;
  }
  if (!isObject(schema)) {
    errors.push(`${where}: a schema must be an object or a boolean`);
    return;
  }
  const ref = schema["$ref"];
  if (ref !== undefined) {
    if (typeof ref !== "string" || resolvePointer(document, ref) === undefined) {
      errors.push(`${where}: $ref ${JSON.stringify(ref)} does not resolve`);
    }
    return;
  }
  const type = schema["type"];
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  for (const entry of types) {
    if (typeof entry !== "string" || !SCHEMA_TYPES.has(entry)) {
      errors.push(`${where}: unknown schema type ${JSON.stringify(entry)}`);
    }
  }
  const properties = schema["properties"];
  if (properties !== undefined) {
    if (!isObject(properties)) {
      errors.push(`${where}: properties must be an object`);
    } else {
      for (const [name, child] of Object.entries(properties)) {
        checkSchema(document, child, `${where}.properties.${name}`, errors);
      }
      const required = schema["required"];
      if (Array.isArray(required)) {
        for (const name of required) {
          if (typeof name !== "string" || !(name in properties)) {
            errors.push(`${where}: required property ${JSON.stringify(name)} is not declared`);
          }
        }
      }
    }
  }
  if (schema["items"] !== undefined) {
    checkSchema(document, schema["items"], `${where}.items`, errors);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const group = schema[key];
    if (Array.isArray(group)) {
      group.forEach((child, index) => {
        checkSchema(document, child, `${where}.${key}[${String(index)}]`, errors);
      });
    }
  }
}

function checkContent(
  document: JsonObject,
  content: unknown,
  where: string,
  errors: string[],
): void {
  if (!isObject(content) || Object.keys(content).length === 0) {
    errors.push(`${where}: content must name at least one media type`);
    return;
  }
  for (const [mediaType, media] of Object.entries(content)) {
    if (!isObject(media) || media["schema"] === undefined) {
      errors.push(`${where}.${mediaType}: a media type needs a schema`);
      continue;
    }
    checkSchema(document, media["schema"], `${where}.${mediaType}.schema`, errors);
  }
}

function checkOperation(
  document: JsonObject,
  operation: unknown,
  path: string,
  where: string,
  operationIds: Set<string>,
  errors: string[],
): void {
  if (!isObject(operation)) {
    errors.push(`${where}: an operation must be an object`);
    return;
  }
  const operationId = operation["operationId"];
  if (typeof operationId !== "string" || operationId.length === 0) {
    errors.push(`${where}: operationId is required`);
  } else if (operationIds.has(operationId)) {
    errors.push(`${where}: operationId "${operationId}" is used twice`);
  } else {
    operationIds.add(operationId);
  }

  const parameters = Array.isArray(operation["parameters"]) ? operation["parameters"] : [];
  const pathParameters = new Set<string>();
  for (const parameter of parameters) {
    if (!isObject(parameter)) {
      errors.push(`${where}: a parameter must be an object`);
      continue;
    }
    const name = parameter["name"];
    const location = parameter["in"];
    if (typeof name !== "string" || typeof location !== "string") {
      errors.push(`${where}: a parameter needs a name and an "in"`);
      continue;
    }
    if (!PARAMETER_LOCATIONS.has(location)) {
      errors.push(`${where}: parameter "${name}" has unknown location "${location}"`);
    }
    if (location === "path") {
      pathParameters.add(name);
      if (parameter["required"] !== true) {
        errors.push(`${where}: path parameter "${name}" must be required`);
      }
    }
    checkSchema(document, parameter["schema"], `${where}.parameters.${name}`, errors);
  }
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1] ?? "";
    if (!pathParameters.has(name)) {
      errors.push(`${where}: path template parameter "${name}" is not declared`);
    }
  }

  const requestBody = operation["requestBody"];
  if (requestBody !== undefined) {
    if (!isObject(requestBody)) {
      errors.push(`${where}: requestBody must be an object`);
    } else {
      checkContent(document, requestBody["content"], `${where}.requestBody.content`, errors);
    }
  }

  const responses = operation["responses"];
  if (!isObject(responses) || Object.keys(responses).length === 0) {
    errors.push(`${where}: responses must list at least one response`);
    return;
  }
  for (const [status, response] of Object.entries(responses)) {
    const responseWhere = `${where}.responses.${status}`;
    if (!STATUS_PATTERN.test(status)) {
      errors.push(`${responseWhere}: "${status}" is not a status code`);
    }
    if (!isObject(response) || typeof response["description"] !== "string") {
      errors.push(`${responseWhere}: a response needs a description`);
      continue;
    }
    if (response["content"] !== undefined) {
      checkContent(document, response["content"], `${responseWhere}.content`, errors);
    }
  }

  const security = operation["security"];
  if (Array.isArray(security)) {
    const schemes = resolvePointer(document, "#/components/securitySchemes");
    for (const requirement of security) {
      for (const name of isObject(requirement) ? Object.keys(requirement) : []) {
        if (!isObject(schemes) || schemes[name] === undefined) {
          errors.push(`${where}: security scheme "${name}" is not defined`);
        }
      }
    }
  }
}

/**
 * Checks `document` against the structural rules of OpenAPI 3.1 that the
 * generated document relies on: the version, `info`, the shape of paths,
 * operations, parameters, request bodies and responses, unique operation
 * ids, path templates matched by path parameters, resolvable `$ref`s and
 * defined security schemes. Returns one message per violation; an empty
 * array means the document is valid.
 */
export function validateOpenApiDocument(document: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(document)) {
    return ["the document must be an object"];
  }
  if (typeof document["openapi"] !== "string" || !/^3\.1\.\d+$/.test(document["openapi"])) {
    errors.push("openapi must be a 3.1.x version string");
  }
  const info = document["info"];
  if (!isObject(info) || typeof info["title"] !== "string" || typeof info["version"] !== "string") {
    errors.push("info needs a title and a version");
  }
  const paths = document["paths"];
  if (!isObject(paths) || Object.keys(paths).length === 0) {
    errors.push("paths must list at least one path");
    return errors;
  }
  const operationIds = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith("/")) {
      errors.push(`path "${path}" must start with a slash`);
    }
    if (!isObject(item)) {
      errors.push(`path "${path}": a path item must be an object`);
      continue;
    }
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) {
        errors.push(`path "${path}": "${method}" is not an http method`);
        continue;
      }
      checkOperation(
        document,
        operation,
        path,
        `${method.toUpperCase()} ${path}`,
        operationIds,
        errors,
      );
    }
  }
  const schemas = resolvePointer(document, "#/components/schemas");
  if (isObject(schemas)) {
    for (const [name, schema] of Object.entries(schemas)) {
      checkSchema(document, schema, `components.schemas.${name}`, errors);
    }
  }
  return errors;
}
