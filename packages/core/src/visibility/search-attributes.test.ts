import { describe, expect, it } from "vitest";
import {
  InvalidSearchAttributesError,
  MAX_MEMO_BYTES,
  MAX_SEARCH_ATTRIBUTE_STRING_LENGTH,
  mergeSearchAttributes,
  validateMemo,
  validateSearchAttributes,
  validateSearchAttributeUpsert,
} from "./search-attributes.ts";

describe("search attribute rules", () => {
  it("accepts strings, finite numbers and booleans under identifier names", () => {
    expect(validateSearchAttributes({ customerId: "c-1", amount: 12.5, vip: false })).toEqual({
      customerId: "c-1",
      amount: 12.5,
      vip: false,
    });
  });

  it.each([
    [{ "customer-id": "x" }, "must be an identifier"],
    [{ "1st": "x" }, "must be an identifier"],
    [{ status: "x" }, "is reserved"],
    [{ startedAt: "x" }, "is reserved"],
    [{ AND: "x" }, "is reserved"],
    [{ amount: Number.NaN }, "finite number"],
    [{ amount: Number.POSITIVE_INFINITY }, "finite number"],
    [{ nested: { a: 1 } }, "a string, a number or a boolean"],
    [{ list: [1] }, "a string, a number or a boolean"],
    [{ gone: null }, "a string, a number or a boolean"],
    [{ long: "x".repeat(MAX_SEARCH_ATTRIBUTE_STRING_LENGTH + 1) }, "longer than"],
    [[], "must be an object"],
    ["c-1", "must be an object"],
  ])("refuses %j", (attributes, message) => {
    expect(() => validateSearchAttributes(attributes)).toThrow(InvalidSearchAttributesError);
    expect(() => validateSearchAttributes(attributes)).toThrow(message);
  });

  it("lets an upsert remove an attribute with null and merges in order", () => {
    const upsert = validateSearchAttributeUpsert({ stage: "done", customerId: null });
    expect(mergeSearchAttributes({ customerId: "c-1", stage: "new" }, upsert)).toEqual({
      stage: "done",
    });
  });

  it("refuses a merge that would hold more than 32 attributes", () => {
    const current = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`a${String(index)}`, index]),
    );
    expect(() => mergeSearchAttributes(current, { extra: 1 })).toThrow("at most 32");
    expect(Object.keys(mergeSearchAttributes(current, { a0: null, extra: 1 }))).toHaveLength(32);
  });

  it("accepts any JSON memo up to its size limit and refuses others", () => {
    expect(validateMemo({ note: "call before shipping", tags: ["a"] })).toEqual({
      note: "call before shipping",
      tags: ["a"],
    });
    expect(() => validateMemo("x".repeat(MAX_MEMO_BYTES))).toThrow("larger than");
    expect(() => validateMemo(() => 1)).toThrow("a JSON value");
  });
});
