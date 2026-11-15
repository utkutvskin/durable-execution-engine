import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_COMPARISONS,
  MAX_QUERY_DEPTH,
  MAX_QUERY_LENGTH,
  VisibilityQueryError,
  compileVisibilityQuery,
} from "./visibility-query.ts";

function positionOf(query: string): number {
  try {
    compileVisibilityQuery(query);
  } catch (error) {
    if (error instanceof VisibilityQueryError) {
      return error.position;
    }
    throw error;
  }
  throw new Error(`"${query}" was accepted`);
}

describe("compileVisibilityQuery", () => {
  it("compiles the example of the backlog into placeholders and values", () => {
    const compiled = compileVisibilityQuery(
      "status = 'FAILED' and customerId = 'c-1' and startedAt > '2026-11-01T00:00:00Z'",
      3,
    );
    expect(compiled.sql).toBe(
      "((status = $3::text and search_attributes @> $4::jsonb) and started_at > $5::timestamptz)",
    );
    expect(compiled.values).toEqual([
      "FAILED",
      JSON.stringify({ customerId: "c-1" }),
      "2026-11-01T00:00:00.000Z",
    ]);
  });

  it("binds or tighter than and, honours parentheses and not, and ignores keyword case", () => {
    expect(compileVisibilityQuery("a = 1 OR b = 2 And c = 3").sql).toBe(
      "(search_attributes @> $1::jsonb or (search_attributes @> $2::jsonb and search_attributes @> $3::jsonb))",
    );
    expect(compileVisibilityQuery("not (a = 1 or b = true)").sql).toBe(
      "(not coalesce((search_attributes @> $1::jsonb or search_attributes @> $2::jsonb), false))",
    );
  });

  it("compares numbers and strings only against attributes of the same type", () => {
    const numeric = compileVisibilityQuery("amount >= 10.5");
    expect(numeric.sql).toContain("jsonb_typeof(search_attributes -> $1::text) = 'number'");
    expect(numeric.values).toEqual(["amount", 10.5]);
    const text = compileVisibilityQuery("region < 'm'");
    expect(text.sql).toContain("= 'string'");
    expect(text.values).toEqual(["region", "m"]);
    expect(compileVisibilityQuery("customerId != 'c-1'").sql).toBe(
      "(search_attributes ? $1::text and not search_attributes @> $2::jsonb)",
    );
  });

  it("reads a doubled quote inside a string as one quote", () => {
    expect(compileVisibilityQuery("note = 'it''s'").values).toEqual([
      JSON.stringify({ note: "it's" }),
    ]);
  });

  it.each([
    ["", 1, "expected a field name"],
    ["status", 7, "expected a comparison operator"],
    ["status = ", 10, "expected a string"],
    ["status = 'FAILED' and", 22, "expected a field name"],
    ["status = 'FAILED' customerId = 'c'", 19, '"and", "or"'],
    ["(status = 'FAILED'", 19, 'expected ")"'],
    ["status = 'FAILED')", 18, '")"'],
    ["status = 'FAILED", 10, "unterminated string"],
    ["status ~ 'x'", 8, 'unexpected character "~"'],
    ["status = 'SLEEPING'", 10, 'unknown status "SLEEPING"'],
    ["status > 'FAILED'", 1, 'only supports "=" and "!="'],
    ["startedAt > 'yesterday'", 13, "ISO-8601 time"],
    ["startedAt > 5", 13, "ISO-8601 time"],
    ["workflowType = 5", 16, "compared with a string"],
    ["runId = 'not-a-uuid'", 9, "uuid"],
    ["flag > true", 8, "a boolean only supports"],
    ["amount = 12abc", 10, "malformed number"],
  ])("refuses %j at position %i", (query, position, message) => {
    expect(positionOf(query)).toBe(position);
    expect(() => compileVisibilityQuery(query)).toThrow(message);
  });

  it.each([
    "status = 'FAILED'; drop table workflow_runs",
    "status = 'FAILED' -- comment",
    "status = 'FAILED' /* x */",
    'customerId = "c-1"',
    "search_attributes->>'x' = 'y'",
    "status = 'FAILED' union select * from api_keys",
    "pg_sleep(10) = 1",
  ])("refuses the hostile query %j with a position", (query) => {
    expect(positionOf(query)).toBeGreaterThan(0);
  });

  it("keeps an injection attempt inside a string as a bound value", () => {
    const compiled = compileVisibilityQuery("customerId = 'x'' or 1=1; drop table tasks; --'");
    expect(compiled.sql).toBe("search_attributes @> $1::jsonb");
    expect(compiled.values).toEqual([
      JSON.stringify({ customerId: "x' or 1=1; drop table tasks; --" }),
    ]);
  });

  it("produces the same SQL whatever the attribute name and the string are", () => {
    const reference = compileVisibilityQuery("a = 'b' or a > 'b'").sql;
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/),
        fc.string({ maxLength: 40 }),
        (name, value) => {
          fc.pre(!["and", "or", "not", "true", "false"].includes(name.toLowerCase()));
          fc.pre(
            !["runId", "status", "workflowType", "queueName", "startedAt", "closedAt"].includes(
              name,
            ),
          );
          const literal = `'${value.replaceAll("'", "''")}'`;
          const compiled = compileVisibilityQuery(`${name} = ${literal} or ${name} > ${literal}`);
          expect(compiled.sql).toBe(reference);
          expect(compiled.values).toEqual([JSON.stringify({ [name]: value }), name, value]);
        },
      ),
    );
  });

  it("refuses a query longer than the limit at the first character past it", () => {
    const query = `a = '${"x".repeat(MAX_QUERY_LENGTH)}'`;
    expect(positionOf(query)).toBe(MAX_QUERY_LENGTH + 1);
  });

  it("refuses more comparisons than the limit at the first one past it", () => {
    const parts = Array.from(
      { length: MAX_QUERY_COMPARISONS + 1 },
      (_, index) => `a${String(index)} = 1`,
    );
    const query = parts.join(" and ");
    expect(positionOf(query)).toBe(query.lastIndexOf("a32") + 1);
  });

  it("refuses nesting deeper than the limit", () => {
    const query = `${"(".repeat(MAX_QUERY_DEPTH + 1)}a = 1${")".repeat(MAX_QUERY_DEPTH + 1)}`;
    expect(positionOf(query)).toBe(MAX_QUERY_DEPTH + 1);
    expect(positionOf(`${"not ".repeat(MAX_QUERY_DEPTH + 1)}a = 1`)).toBe(MAX_QUERY_DEPTH * 4 + 1);
    expect(
      compileVisibilityQuery(`${"(".repeat(MAX_QUERY_DEPTH)}a = 1${")".repeat(MAX_QUERY_DEPTH)}`)
        .values,
    ).toEqual([JSON.stringify({ a: 1 })]);
  });
});
