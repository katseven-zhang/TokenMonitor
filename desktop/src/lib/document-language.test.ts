import { describe, expect, it } from "vitest";
import { applyDocumentLanguage, htmlLangFor } from "./document-language";

describe("document language", () => {
  it("maps the supported app languages onto real BCP-47 tags", () => {
    expect(htmlLangFor("zh")).toBe("zh-CN");
    expect(htmlLangFor("ja")).toBe("ja-JP");
    expect(htmlLangFor("en")).toBe("en");
    expect(htmlLangFor("en-US")).toBe("en");
    expect(htmlLangFor("zh-TW")).toBe("zh-CN");
  });

  it("keeps an unknown language announceable instead of falling back to Chinese", () => {
    expect(htmlLangFor("fr")).toBe("fr");
    expect(htmlLangFor("")).toBe("en");
  });

  it("writes the tag onto the document element and returns it", () => {
    const doc = { documentElement: { lang: "zh-CN" } };
    expect(applyDocumentLanguage("en", doc)).toBe("en");
    expect(doc.documentElement.lang).toBe("en");
    expect(applyDocumentLanguage("ja", doc)).toBe("ja-JP");
    expect(doc.documentElement.lang).toBe("ja-JP");
  });

  it("survives a host without a document instead of throwing at import time", () => {
    expect(applyDocumentLanguage("zh", undefined)).toBe("zh-CN");
  });
});
