import { BUILT_IN_VISIBILITY_FIELDS } from "./search-attributes.ts";

/**
 * The longest visibility query accepted, in characters.
 */
export const MAX_QUERY_LENGTH = 2000;

/**
 * The most comparisons one visibility query may hold.
 */
export const MAX_QUERY_COMPARISONS = 32;

/**
 * How deeply a visibility query may nest parentheses and `not`.
 */
export const MAX_QUERY_DEPTH = 16;

/**
 * Thrown for a visibility query that cannot be parsed or does not make
 * sense: `position` is the 1-based character position of the offending
 * token (the length of the query plus one for an unexpected end).
 */
export class VisibilityQueryError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} at position ${String(position)}`);
    this.name = "VisibilityQueryError";
    this.position = position;
  }
}

/**
 * A parsed visibility query compiled to a SQL condition over
 * `workflow_runs`. `sql` only refers to its values through `$n`
 * placeholders numbered from the `firstParameter` given to
 * `compileVisibilityQuery`; nothing from the query text is ever copied into
 * `sql`.
 */
export interface CompiledVisibilityQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

type ComparisonOperator = "=" | "!=" | "<" | "<=" | ">" | ">=";

type Token =
  | { readonly kind: "identifier"; readonly text: string; readonly position: number }
  | { readonly kind: "string"; readonly value: string; readonly position: number }
  | { readonly kind: "number"; readonly value: number; readonly position: number }
  | { readonly kind: "operator"; readonly operator: ComparisonOperator; readonly position: number }
  | { readonly kind: "open" | "close" | "end"; readonly position: number };

type Literal =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean };

type QueryNode =
  | { readonly kind: "and" | "or"; readonly left: QueryNode; readonly right: QueryNode }
  | { readonly kind: "not"; readonly operand: QueryNode }
  | {
      readonly kind: "compare";
      readonly field: string;
      readonly fieldPosition: number;
      readonly operator: ComparisonOperator;
      readonly literal: Literal;
      readonly literalPosition: number;
    };

const RUN_STATUSES = new Set([
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "TERMINATED",
  "CONTINUED_AS_NEW",
]);

const KEYWORD_FIELDS: Readonly<Record<string, string>> = {
  runId: "id",
  status: "status",
  workflowType: "workflow_type",
  queueName: "queue_name",
};

const TIME_FIELDS: Readonly<Record<string, string>> = {
  startedAt: "started_at",
  closedAt: "closed_at",
};

const ISO_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function readOperator(
  query: string,
  index: number,
): { readonly operator: ComparisonOperator; readonly length: number } | undefined {
  const two = query.slice(index, index + 2);
  if (two === "!=" || two === "<>") {
    return { operator: "!=", length: 2 };
  }
  if (two === "<=" || two === ">=") {
    return { operator: two, length: 2 };
  }
  const one = query[index];
  if (one === "=" || one === "<" || one === ">") {
    return { operator: one, length: 1 };
  }
  return undefined;
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < query.length) {
    const character = query[index] ?? "";
    const position = index + 1;
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === "(") {
      tokens.push({ kind: "open", position });
      index += 1;
    } else if (character === ")") {
      tokens.push({ kind: "close", position });
      index += 1;
    } else if (character === "'") {
      let value = "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < query.length) {
        const next = query[cursor];
        if (next === "'") {
          if (query[cursor + 1] === "'") {
            value += "'";
            cursor += 2;
            continue;
          }
          closed = true;
          cursor += 1;
          break;
        }
        value += next ?? "";
        cursor += 1;
      }
      if (!closed) {
        throw new VisibilityQueryError("unterminated string", position);
      }
      tokens.push({ kind: "string", value, position });
      index = cursor;
    } else if (isDigit(character) || (character === "-" && isDigit(query[index + 1]))) {
      const match = /^-?\d+(\.\d+)?/.exec(query.slice(index));
      const text = match?.[0] ?? character;
      if (isIdentifierStart(query[index + text.length] ?? "")) {
        throw new VisibilityQueryError(`malformed number "${text}..."`, position);
      }
      tokens.push({ kind: "number", value: Number(text), position });
      index += text.length;
    } else if (isIdentifierStart(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(query.slice(index));
      const text = match?.[0] ?? character;
      tokens.push({ kind: "identifier", text, position });
      index += text.length;
    } else {
      const operator = readOperator(query, index);
      if (operator === undefined) {
        throw new VisibilityQueryError(`unexpected character "${character}"`, position);
      }
      tokens.push({ kind: "operator", operator: operator.operator, position });
      index += operator.length;
    }
  }
  tokens.push({ kind: "end", position: query.length + 1 });
  return tokens;
}

function isKeyword(token: Token, keyword: string): boolean {
  return token.kind === "identifier" && token.text.toLowerCase() === keyword;
}

function describe(token: Token): string {
  switch (token.kind) {
    case "identifier":
      return `"${token.text}"`;
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "operator":
      return `"${token.operator}"`;
    case "open":
      return '"("';
    case "close":
      return '")"';
    case "end":
      return "the end of the query";
  }
}

function parse(tokens: readonly Token[]): QueryNode {
  let index = 0;
  let comparisons = 0;

  function peek(): Token {
    return tokens[index] ?? { kind: "end", position: 0 };
  }

  function advance(): Token {
    const token = peek();
    index += 1;
    return token;
  }

  function unexpected(token: Token, expected: string): VisibilityQueryError {
    return new VisibilityQueryError(
      `expected ${expected} but found ${describe(token)}`,
      token.position,
    );
  }

  function parseOr(depth: number): QueryNode {
    let node = parseAnd(depth);
    while (isKeyword(peek(), "or")) {
      advance();
      node = { kind: "or", left: node, right: parseAnd(depth) };
    }
    return node;
  }

  function parseAnd(depth: number): QueryNode {
    let node = parseUnary(depth);
    while (isKeyword(peek(), "and")) {
      advance();
      node = { kind: "and", left: node, right: parseUnary(depth) };
    }
    return node;
  }

  function parseUnary(depth: number): QueryNode {
    const token = peek();
    const nests = isKeyword(token, "not") || token.kind === "open";
    if (nests && depth >= MAX_QUERY_DEPTH) {
      throw new VisibilityQueryError(
        `the query nests deeper than ${String(MAX_QUERY_DEPTH)} levels`,
        token.position,
      );
    }
    if (isKeyword(token, "not")) {
      advance();
      return { kind: "not", operand: parseUnary(depth + 1) };
    }
    if (token.kind === "open") {
      advance();
      const inner = parseOr(depth + 1);
      const close = advance();
      if (close.kind !== "close") {
        throw unexpected(close, '")"');
      }
      return inner;
    }
    return parseComparison();
  }

  function parseLiteral(): { readonly literal: Literal; readonly position: number } {
    const token = advance();
    if (token.kind === "string") {
      return { literal: { kind: "string", value: token.value }, position: token.position };
    }
    if (token.kind === "number") {
      return { literal: { kind: "number", value: token.value }, position: token.position };
    }
    if (isKeyword(token, "true") || isKeyword(token, "false")) {
      return {
        literal: { kind: "boolean", value: isKeyword(token, "true") },
        position: token.position,
      };
    }
    throw unexpected(token, "a string, a number, true or false");
  }

  function parseComparison(): QueryNode {
    const field = advance();
    if (
      field.kind !== "identifier" ||
      ["and", "or", "not", "true", "false"].includes(field.text.toLowerCase())
    ) {
      throw unexpected(field, "a field name");
    }
    comparisons += 1;
    if (comparisons > MAX_QUERY_COMPARISONS) {
      throw new VisibilityQueryError(
        `the query holds more than ${String(MAX_QUERY_COMPARISONS)} comparisons`,
        field.position,
      );
    }
    const operator = advance();
    if (operator.kind !== "operator") {
      throw unexpected(operator, "a comparison operator");
    }
    const { literal, position } = parseLiteral();
    return {
      kind: "compare",
      field: field.text,
      fieldPosition: field.position,
      operator: operator.operator,
      literal,
      literalPosition: position,
    };
  }

  const root = parseOr(0);
  const rest = peek();
  if (rest.kind !== "end") {
    throw unexpected(rest, '"and", "or" or the end of the query');
  }
  return root;
}

function compileNode(node: QueryNode, values: unknown[], firstParameter: number): string {
  function parameter(value: unknown): string {
    values.push(value);
    return `$${String(firstParameter + values.length - 1)}`;
  }

  function compileKeyword(
    column: string,
    compare: Extract<QueryNode, { kind: "compare" }>,
  ): string {
    if (compare.literal.kind !== "string") {
      throw new VisibilityQueryError(
        `${compare.field} is compared with a string`,
        compare.literalPosition,
      );
    }
    if (compare.operator !== "=" && compare.operator !== "!=") {
      throw new VisibilityQueryError(
        `${compare.field} only supports "=" and "!="`,
        compare.fieldPosition,
      );
    }
    if (compare.field === "status" && !RUN_STATUSES.has(compare.literal.value)) {
      throw new VisibilityQueryError(
        `unknown status "${compare.literal.value}"`,
        compare.literalPosition,
      );
    }
    if (compare.field === "runId" && !UUID_PATTERN.test(compare.literal.value)) {
      throw new VisibilityQueryError("runId is compared with a uuid", compare.literalPosition);
    }
    const cast = compare.field === "runId" ? "::uuid" : "::text";
    return `${column} ${compare.operator === "=" ? "=" : "<>"} ${parameter(compare.literal.value)}${cast}`;
  }

  function compileTime(column: string, compare: Extract<QueryNode, { kind: "compare" }>): string {
    if (
      compare.literal.kind !== "string" ||
      !ISO_TIME_PATTERN.test(compare.literal.value) ||
      Number.isNaN(Date.parse(compare.literal.value))
    ) {
      throw new VisibilityQueryError(
        `${compare.field} is compared with an ISO-8601 time in quotes`,
        compare.literalPosition,
      );
    }
    const operator = compare.operator === "!=" ? "<>" : compare.operator;
    return `${column} ${operator} ${parameter(new Date(compare.literal.value).toISOString())}::timestamptz`;
  }

  function compileAttribute(compare: Extract<QueryNode, { kind: "compare" }>): string {
    const { literal, operator } = compare;
    if (operator === "=") {
      return `search_attributes @> ${parameter(JSON.stringify({ [compare.field]: literal.value }))}::jsonb`;
    }
    if (operator === "!=") {
      const name = parameter(compare.field);
      const match = parameter(JSON.stringify({ [compare.field]: literal.value }));
      return `(search_attributes ? ${name}::text and not search_attributes @> ${match}::jsonb)`;
    }
    if (literal.kind === "boolean") {
      throw new VisibilityQueryError(
        `a boolean only supports "=" and "!="`,
        compare.literalPosition,
      );
    }
    const name = parameter(compare.field);
    if (literal.kind === "number") {
      return (
        `(case when jsonb_typeof(search_attributes -> ${name}::text) = 'number' ` +
        `then (search_attributes ->> ${name}::text)::numeric end) ${operator} ${parameter(literal.value)}::numeric`
      );
    }
    return (
      `(case when jsonb_typeof(search_attributes -> ${name}::text) = 'string' ` +
      `then search_attributes ->> ${name}::text end) collate "C" ${operator} ${parameter(literal.value)}::text`
    );
  }

  switch (node.kind) {
    case "and":
    case "or":
      return `(${compileNode(node.left, values, firstParameter)} ${node.kind} ${compileNode(node.right, values, firstParameter)})`;
    case "not":
      return `(not coalesce(${compileNode(node.operand, values, firstParameter)}, false))`;
    case "compare": {
      const keywordColumn = KEYWORD_FIELDS[node.field];
      if (keywordColumn !== undefined) {
        return compileKeyword(keywordColumn, node);
      }
      const timeColumn = TIME_FIELDS[node.field];
      if (timeColumn !== undefined) {
        return compileTime(timeColumn, node);
      }
      return compileAttribute(node);
    }
  }
}

/**
 * Parses a visibility query and compiles it to a parameterized SQL
 * condition over `workflow_runs`. The grammar:
 *
 * ```
 * query      := or
 * or         := and ("or" and)*
 * and        := unary ("and" unary)*
 * unary      := "not" unary | "(" or ")" | comparison
 * comparison := field ("=" | "!=" | "<>" | "<" | "<=" | ">" | ">=") literal
 * literal    := 'string' | number | true | false
 * ```
 *
 * Keywords are case insensitive, a quote inside a string is written twice.
 * `runId`, `status`, `workflowType` and `queueName` take a string and only
 * `=` and `!=`; `startedAt` and `closedAt` take an ISO-8601 time in quotes;
 * every other field is a search attribute. On a search attribute `=` uses
 * the GIN index, `!=` matches runs that hold the attribute with another
 * value, and an ordering only matches values of the literal's type.
 * Rejects with `VisibilityQueryError` naming the position.
 */
export function compileVisibilityQuery(query: string, firstParameter = 1): CompiledVisibilityQuery {
  if (query.length > MAX_QUERY_LENGTH) {
    throw new VisibilityQueryError(
      `the query is longer than ${String(MAX_QUERY_LENGTH)} characters`,
      MAX_QUERY_LENGTH + 1,
    );
  }
  const root = parse(tokenize(query));
  const values: unknown[] = [];
  const sql = compileNode(root, values, firstParameter);
  return { sql, values };
}

/**
 * Whether `field` is one of the run fields a visibility query reads from
 * the run row rather than from its search attributes.
 */
export function isBuiltInVisibilityField(field: string): boolean {
  return BUILT_IN_VISIBILITY_FIELDS.includes(field);
}
