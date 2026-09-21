// The desktop bundle is built for ES2022 (`build.target` in vite.config.ts and
// `target`/`lib` in tsconfig.json). esbuild only downlevels syntax: it never
// polyfills `Array.prototype.findLast` (ES2023), so calling it added a runtime
// requirement the build never promised. The search walks backwards instead.
export function findLastItem<T>(items: readonly T[], predicate: (item: T, index: number) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return items[index];
  }
  return undefined;
}
