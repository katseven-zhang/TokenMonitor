import { describe,it,expect,vi } from 'vitest';
import { latestLoader } from './latest-loader';
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
describe('slow dashboard refreshes',()=>{
  it('lets a slow response finish despite repeated polling',async()=>{
    const wait=deferred<number>(),load=vi.fn(()=>wait.promise),publish=vi.fn();
    const loader=latestLoader((a:string,b)=>a===b,load,publish,vi.fn());
    const first=loader.run('same');
    expect(loader.run('same')).toBe(first);
    expect(loader.run('same')).toBe(first);
    await Promise.resolve();expect(load).toHaveBeenCalledTimes(1);
    wait.resolve(42);await first;expect(publish).toHaveBeenCalledWith(42);
  });
  it('ignores stale successes and failures after changing filters',async()=>{
    const old=deferred<number>(),current=deferred<number>(),publish=vi.fn(),fail=vi.fn();
    const loader=latestLoader((a:string,b)=>a===b,key=>key==='old'?old.promise:current.promise,publish,fail);
    const a=loader.run('old'),b=loader.run('new');current.resolve(2);await b;old.reject(Error('stale'));await a;
    expect(publish.mock.calls).toEqual([[2]]);expect(fail).not.toHaveBeenCalled();
  });
  it('forces a new result after pricing/settings changes without old data winning',async()=>{
    const old=deferred<number>(),fresh=deferred<number>(),publish=vi.fn();
    const load=vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const loader=latestLoader((a:string,b)=>a===b,load,publish,vi.fn());
    const a=loader.run('same'),b=loader.run('same',true);fresh.resolve(20);await b;old.resolve(10);await a;
    expect(load).toHaveBeenCalledTimes(2);expect(publish.mock.calls).toEqual([[20]]);
  });
});
