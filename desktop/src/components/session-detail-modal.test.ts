import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatCompactTokenCount,
  tabWrapTarget,
  withoutInerted,
} from "./session-detail-modal";

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

// Task #119: the modal's Tab trap and the collapsed (inert) header.
// vitest here runs in the node environment with no DOM harness, so the two things that
// were actually broken are extracted as pure functions and driven directly: which element
// a Tab should wrap to, and whether an element inside an `inert` subtree gets filtered out.
describe("modal focus trap (#119)", () => {
  const [header, content, tail] = ["header", "content", "tail"];

  it("wraps from the last element back to the first", () => {
    expect(tabWrapTarget([header, content, tail], tail, false)).toBe("first");
  });

  it("wraps backwards from the first element to the last", () => {
    expect(tabWrapTarget([header, content, tail], header, true)).toBe("last");
  });

  it("leaves every other key press to the browser", () => {
    expect(tabWrapTarget([header, content, tail], content, false)).toBe("none");
    expect(tabWrapTarget([header, content, tail], content, true)).toBe("none");
    expect(tabWrapTarget([header, content, tail], null, false)).toBe("none");
  });

  it("reports nothing to wrap to when the set is empty", () => {
    expect(tabWrapTarget<string>([], null, false)).toBe("none");
  });

  /// 修前的缺陷本体（两个方向各半）：折叠头部里的元素仍被 querySelectorAll 匹配到，
  /// 于是集合的**第一个**是头部里的 inert 元素。
  /// ① 回环落点错：`tabWrapTarget` 说"回到 first"，调用方 focus 的是那个 inert 元素，
  ///    浏览器把焦点丢回 body —— 看起来像"焦点逃出了对话框"。
  /// ② 回环条件永不成立：真正在第一个内容元素上按 Shift+Tab 时，修前它不是集合首位，
  ///    判定返回 "none"，焦点向后逃出对话框。
  it("computes the wrap point from the filtered set, not the raw query order", () => {
    // 元素替身只实现 `closest`，因为被测判定只用到它。头部是 inert 的那一个。
    const fake = (names: string[], inerted: string[]) =>
      names.map((n) => ({
        name: n,
        closest: (selector: string) => (inerted.includes(n) && selector === "[inert]" ? {} : null),
      }));
    const raw = fake([header, content, tail], [header]);
    const visible = withoutInerted(raw);
    expect(visible.map((e) => e.name)).toEqual([content, tail]);
    const names = (list: { name: string }[]) => list.map((e) => e.name);
    // ① 落点：过滤后的首位是内容元素；修前 focus 的是头部的 inert 元素，浏览器把焦点丢回 body
    expect(tabWrapTarget(names(visible), content, false)).toBe("none");
    expect(tabWrapTarget(names(visible), tail, false)).toBe("first");
    expect(visible[0].name).toBe(content);
    expect(raw[0].name).toBe(header);
    // ② 条件：在第一个内容元素上 Shift+Tab，过滤后才回环到末尾（修前判定永不成立）
    expect(tabWrapTarget(names(visible), content, true)).toBe("last");
    expect(tabWrapTarget(names(raw), content, true)).toBe("none");
  });
});

describe("inert filtering (#119)", () => {
  const inside = { closest: (selector: string) => (selector === "[inert]" ? {} : null) };
  const outside = { closest: () => null };

  it("drops elements whose ancestor is inert, keeping the rest in order", () => {
    expect(withoutInerted([outside, inside, outside])).toEqual([outside, outside]);
  });

  it("treats an inert attribute as inert regardless of its value", () => {
    // React renders `inert={true}` as `inert=""`, hand-written markup may be "true".
    const emptyValue = { closest: () => ({ value: "" }) };
    expect(withoutInerted([emptyValue, outside])).toEqual([outside]);
  });

  it("keeps everything when nothing is inert", () => {
    expect(withoutInerted([outside, outside])).toHaveLength(2);
  });
});

/// 接线门（【接】级证据，只挡"改回去"，不证行为）：本仓库的 desktop 单测跑在 node 环境、
/// 没有 DOM 装置，所以真正被单测驱动的是上面两个纯函数；这里再钉一次"处理器确实把它们
/// 串在了一起"。判定用可读的文本结构，不用宽泛的 includes：
/// querySelectorAll 的结果必须先过 withoutInerted，再交给 tabWrapTarget。
describe("trap wiring (#119)", () => {
  const source = readFileSync("./src/components/session-detail-modal.tsx", "utf8");

  it("pipes the queried elements through the inert filter before wrapping", () => {
    const handler = source.slice(source.indexOf('if (event.key !== "Tab") return;'));
    const filtered = handler.indexOf("withoutInerted(");
    const queried = handler.indexOf("dialog.querySelectorAll<HTMLElement>");
    const wrapped = handler.indexOf("tabWrapTarget<HTMLElement>(");
    expect(filtered).toBeGreaterThan(-1);
    expect(queried).toBeGreaterThan(filtered); // 查询结果是过滤的**入参**
    expect(wrapped).toBeGreaterThan(queried); // 先过滤，再算回环
    // 两者之间只允许出现 `withoutInerted(Array.from(` 与空白：换一种接法就得改这条，
    // 也就挡住"把过滤挪到别处/干脆删掉"的悄悄回退。
    const between = handler.slice(filtered, queried).replace(/\s+/g, "");
    expect(between).toBe("withoutInerted(Array.from(");
  });

  it("no longer compares activeElement against a raw query list", () => {
    // 修前的写法：在 Tab 处理器里直接比 first/last（它们取自未过滤集合）。
    // 只扫处理器这一段：文件里的说明性注释会提到这个写法，那不是回归。
    const handler = source.slice(source.indexOf('if (event.key !== "Tab") return;'));
    expect(handler).not.toMatch(/document\.activeElement === (first|last)/);
  });
});
