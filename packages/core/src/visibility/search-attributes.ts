/**
 * The value of one search attribute: a string, a finite number or a
 * boolean. A string holding an ISO-8601 time compares in time order,
 * because the format sorts like the time it names.
 */
export type SearchAttributeValue = string | number | boolean;

/**
 * The search attributes of a run, keyed by attribute name.
 */
export type SearchAttributes = Readonly<Record<string, SearchAttributeValue>>;

/**
 * An upsert of search attributes: each value replaces the attribute of that
 * name, and `null` removes it.
 */
export type SearchAttributeUpsert = Readonly<Record<string, SearchAttributeValue | null>>;

/**
 * How many search attributes one run may hold.
 */
export const MAX_SEARCH_ATTRIBUTES = 32;

/**
 * The longest string value a search attribute may hold.
 */
export const MAX_SEARCH_ATTRIBUTE_STRING_LENGTH = 256;

/**
 * The longest name a search attribute may have.
 */
export const MAX_SEARCH_ATTRIBUTE_NAME_LENGTH = 64;

/**
 * The largest memo a run may carry, in bytes of its JSON text.
 */
export const MAX_MEMO_BYTES = 16 * 1024;

/**
 * The fields of a run a visibility query can filter on besides its search
 * attributes. No search attribute may take one of these names.
 */
export const BUILT_IN_VISIBILITY_FIELDS: readonly string[] = [
  "runId",
  "status",
  "workflowType",
  "queueName",
  "startedAt",
  "closedAt",
];

const RESERVED_WORDS = new Set(["and", "or", "not", "true", "false"]);

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Thrown when search attributes or a memo break the rules: a name that is
 * not an identifier, reserved or too long, a value that is not a string, a
 * finite number or a boolean, a string that is too long, too many
 * attributes, or a memo that is not a JSON value or is too large.
 */
export class InvalidSearchAttributesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSearchAttributesError";
  }
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.length > MAX_SEARCH_ATTRIBUTE_NAME_LENGTH) {
    throw new InvalidSearchAttributesError(
      `search attribute name "${name}" must be an identifier of at most ` +
        `${String(MAX_SEARCH_ATTRIBUTE_NAME_LENGTH)} characters (letters, digits, underscore)`,
    );
  }
  if (BUILT_IN_VISIBILITY_FIELDS.includes(name) || RESERVED_WORDS.has(name.toLowerCase())) {
    throw new InvalidSearchAttributesError(`search attribute name "${name}" is reserved`);
  }
}

function assertValue(name: string, value: unknown): asserts value is SearchAttributeValue {
  if (typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidSearchAttributesError(`search attribute "${name}" must be a finite number`);
    }
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_SEARCH_ATTRIBUTE_STRING_LENGTH) {
      throw new InvalidSearchAttributesError(
        `search attribute "${name}" is longer than ` +
          `${String(MAX_SEARCH_ATTRIBUTE_STRING_LENGTH)} characters`,
      );
    }
    return;
  }
  throw new InvalidSearchAttributesError(
    `search attribute "${name}" must be a string, a number or a boolean`,
  );
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidSearchAttributesError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertCount(attributes: Readonly<Record<string, unknown>>): void {
  if (Object.keys(attributes).length > MAX_SEARCH_ATTRIBUTES) {
    throw new InvalidSearchAttributesError(
      `a run holds at most ${String(MAX_SEARCH_ATTRIBUTES)} search attributes`,
    );
  }
}

/**
 * Checks the search attributes a run starts with and returns them. Rejects
 * with `InvalidSearchAttributesError`.
 */
export function validateSearchAttributes(value: unknown): SearchAttributes {
  const record = asRecord(value, "search attributes");
  for (const [name, attribute] of Object.entries(record)) {
    assertName(name);
    assertValue(name, attribute);
  }
  assertCount(record);
  return record as SearchAttributes;
}

/**
 * Checks an upsert (a `null` value removes the attribute) and returns it.
 * Rejects with `InvalidSearchAttributesError`.
 */
export function validateSearchAttributeUpsert(value: unknown): SearchAttributeUpsert {
  const record = asRecord(value, "a search attribute upsert");
  for (const [name, attribute] of Object.entries(record)) {
    assertName(name);
    if (attribute !== null) {
      assertValue(name, attribute);
    }
  }
  assertCount(record);
  return record as SearchAttributeUpsert;
}

/**
 * Applies `upsert` to `current`: values replace, `null` removes. Rejects
 * with `InvalidSearchAttributesError` when the result holds too many
 * attributes.
 */
export function mergeSearchAttributes(
  current: SearchAttributes,
  upsert: SearchAttributeUpsert,
): SearchAttributes {
  const merged: Record<string, SearchAttributeValue> = { ...current };
  for (const [name, value] of Object.entries(upsert)) {
    if (value === null) {
      Reflect.deleteProperty(merged, name);
    } else {
      merged[name] = value;
    }
  }
  assertCount(merged);
  return merged;
}

/**
 * Checks a memo: any JSON value of at most `MAX_MEMO_BYTES`. Rejects with
 * `InvalidSearchAttributesError`.
 */
export function validateMemo(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    throw new InvalidSearchAttributesError("the memo must be a JSON value");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_MEMO_BYTES) {
    throw new InvalidSearchAttributesError(
      `the memo is larger than ${String(MAX_MEMO_BYTES)} bytes`,
    );
  }
  return JSON.parse(text) as unknown;
}
