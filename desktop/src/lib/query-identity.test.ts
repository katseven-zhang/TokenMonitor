import { describe, expect, it } from 'vitest';
import { sameQuery } from './query-identity';
import type { Query } from './api';

const base: Query = {start:60_000,end:120_000,agent:'codex',model:null,project:null,session:null,search:'',offsetMinutes:480};
describe('query response identity', () => {
  it('does not depend on JSON property order', () => {
    const reversed = Object.fromEntries(Object.entries(base).reverse()) as Query;
    expect(sameQuery(base,reversed)).toBe(true);
  });
  it('rejects stale results after every supported filter change', () => {
    const changes: Partial<Query>[] = [{start:0},{end:180_000},{agent:'zcode'},{model:'m'},{project:'p'},{session:'s'},{search:'title'},{offsetMinutes:0}];
    for(const change of changes) expect(sameQuery(base,{...base,...change})).toBe(false);
  });
});
