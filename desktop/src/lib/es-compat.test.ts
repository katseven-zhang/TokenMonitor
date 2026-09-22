import { describe, expect, it } from "vitest";
import { findLastItem } from "./es-compat";

describe("findLastItem", () => {
  it("returns the last element that matches instead of the first", () => {
    const items = [{ n: 1 }, { n: 2 }, { n: 1 }];
    expect(findLastItem(items, (item) => item.n === 1)).toBe(items[2]);
  });

  it("reports no match as undefined", () => {
    expect(findLastItem([1, 2, 3], (value) => value > 5)).toBeUndefined();
    expect(findLastItem([], () => true)).toBeUndefined();
  });

  it("walks backwards, so a later duplicate wins for the token-folding case", () => {
    const entries = ["visible", "hidden", "visible"];
    const seen: string[] = [];
    const found = findLastItem(entries, (entry) => {
      seen.push(entry);
      return entry === "visible";
    });
    expect(found).toBe("visible");
    expect(seen).toEqual(["visible"]);
  });

  it("works on arrays that have no findLast method, as the declared ES2022 bundle requires", () => {
    const items = [10, 20, 30];
    delete (items as unknown as { findLast?: unknown }).findLast;
    expect(findLastItem(items, (value) => value === 20)).toBe(20);
  });
});
