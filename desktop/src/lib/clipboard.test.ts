import { afterEach,describe,expect,it } from 'vitest';
import { writeClipboard } from './clipboard';

const original = Object.getOwnPropertyDescriptor(globalThis,'navigator');
afterEach(()=>{ if(original) Object.defineProperty(globalThis,'navigator',original); else delete (globalThis as {navigator?:unknown}).navigator; });

describe('clipboard writes',()=>{
  it('reports the clipboard being absent as a failure instead of a success',async()=>{
    delete (globalThis as {navigator?:unknown}).navigator;
    expect(await writeClipboard('x')).toEqual({ ok:false,reason:'unavailable' });
    Object.defineProperty(globalThis,'navigator',{ value:{}, configurable:true });
    expect(await writeClipboard('x')).toEqual({ ok:false,reason:'unavailable' });
  });

  it('reports a rejected write as a failure',async()=>{
    Object.defineProperty(globalThis,'navigator',{ configurable:true,value:{ clipboard:{ writeText:()=>Promise.reject(new Error('denied')) } } });
    expect(await writeClipboard('x')).toEqual({ ok:false,reason:'rejected' });
  });

  it('reports success only when the write resolved',async()=>{
    const written:string[]=[];
    Object.defineProperty(globalThis,'navigator',{ configurable:true,value:{ clipboard:{ writeText:(text:string)=>{written.push(text);return Promise.resolve();} } } });
    expect(await writeClipboard('7.2')).toEqual({ ok:true });
    expect(written).toEqual(['7.2']);
  });
});
