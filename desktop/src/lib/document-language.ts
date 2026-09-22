// `index.html` ships a static `<html lang="zh-CN">`. Nothing ever updated it, so
// after switching to English or Japanese the UI text changed while the document
// still announced itself as Chinese to screen readers and to `toLocaleString`
// callers that omit an explicit locale.
export function htmlLangFor(language: string): string {
  const base = language.split("-")[0]?.toLowerCase() ?? "";
  if (base === "zh") return "zh-CN";
  if (base === "ja") return "ja-JP";
  if (base === "en") return "en";
  return language || "en";
}

type DocumentLike = { documentElement?: { lang: string } } | undefined;

export function applyDocumentLanguage(language: string, doc: DocumentLike = globalThis.document): string {
  const tag = htmlLangFor(language);
  if (doc?.documentElement) doc.documentElement.lang = tag;
  return tag;
}
