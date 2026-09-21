// Paging state for the two front-end tables. Both used to be reset by remounting the
// component with a query-derived React key, which threw away the user's sort and page
// on every keystroke; these helpers let the components stay mounted and decide in one
// place when a request actually changed.

export type PagedRequest<Key> = { key: Key; offset: number };

/** A new filter restarts at the first page; an unrelated re-render keeps the current one. */
export function requestFor<Key>(key: Key, previous: PagedRequest<Key> | null, equal: (a: Key, b: Key) => boolean): PagedRequest<Key> {
  return previous && equal(previous.key, key) ? previous : { key, offset: 0 };
}

/** True only when a loaded page belongs to the request that is on screen right now. */
export function isCurrentRequest<Key>(loaded: PagedRequest<Key> | null, current: PagedRequest<Key>, equal: (a: Key, b: Key) => boolean): loaded is PagedRequest<Key> {
  return loaded !== null && loaded.offset === current.offset && equal(loaded.key, current.key);
}

export function pageNumberOf(offset: number, limit: number): number {
  return Math.floor(offset / limit) + 1;
}

/** `null` total means "nothing loaded for this request yet", which is not the same as one page. */
export function pageCountOf(total: number | null, limit: number): number | null {
  return total === null ? null : Math.max(1, Math.ceil(total / limit));
}

/** The last offset that still holds a row, or `null` while the total is unknown. */
export function lastPageOffset(total: number | null, limit: number): number | null {
  const pages = pageCountOf(total, limit);
  return pages === null ? null : (pages - 1) * limit;
}

export function canStepTo(offset: number, limit: number, total: number | null, direction: 'back' | 'forward'): boolean {
  if (total === null) return false;
  return direction === 'back' ? offset > 0 : offset + limit < total;
}
