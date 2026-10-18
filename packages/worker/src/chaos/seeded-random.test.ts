import { describe, expect, it } from "vitest";
import { createSeededRandom } from "./seeded-random.js";

describe("seeded random", () => {
  it("repeats the same sequence for the same seed", () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);
    expect(Array.from({ length: 5 }, () => first())).toEqual(
      Array.from({ length: 5 }, () => second()),
    );
  });

  it("gives another sequence for another seed", () => {
    expect(createSeededRandom(1)()).not.toBe(createSeededRandom(2)());
  });

  it("stays within zero and one", () => {
    const random = createSeededRandom(7);
    const values = Array.from({ length: 1000 }, () => random());
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
