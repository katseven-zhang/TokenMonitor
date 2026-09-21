import { describe, expect, it } from "vitest";
import { formatCompactTokenCount } from "./session-detail-modal";

// Task #84 criterion 7: the scale stopped at `m`, so a long-running session's token total
// printed as `1500m`. Every other tier divides by its own unit, so a value that needs one
// more unit has to get it instead of growing four digits in front of a suffix.
describe("compact token count", () => {
  it("keeps the two smaller tiers dividing by their own unit", () => {
    expect(formatCompactTokenCount(999)).toBe("999");
    expect(formatCompactTokenCount(1_500)).toBe("1.5k");
    expect(formatCompactTokenCount(1_500_000)).toBe("1.5m");
  });

  it("gives a figure of a billion or more its own tier", () => {
    expect(formatCompactTokenCount(1_500_000_000)).toBe("1.5b");
    expect(formatCompactTokenCount(1_000_000_000)).toBe("1b");
    expect(formatCompactTokenCount(2_340_000_000)).toBe("2.3b");
  });

  it("does not leave a billion-scale total wearing the megabyte tier's suffix", () => {
    expect(formatCompactTokenCount(1_500_000_000)).not.toBe("1500m");
  });

  it("keeps the tier boundary on the side that still fits", () => {
    expect(formatCompactTokenCount(999_999_999)).toMatch(/m$/);
    expect(formatCompactTokenCount(1_000_000_000)).toMatch(/b$/);
  });
});
