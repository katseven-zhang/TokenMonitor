/** Coalesce periodic refreshes; only the newest distinct/forced request may publish. */
export function latestLoader<Key,Value>(equal:(a:Key,b:Key)=>boolean,load:(key:Key)=>Promise<Value>,publish:(value:Value)=>void,fail:(error:unknown)=>void) {
  let serial=0;
  let pending:{key:Key;ticket:number;promise:Promise<void>}|null=null;
  return {run(key:Key,force=false):Promise<void>{
    if(!force&&pending&&equal(key,pending.key)) return pending.promise;
    const ticket=++serial;
    const promise=Promise.resolve().then(()=>load(key)).then(value=>{if(ticket===serial)publish(value);}).catch(error=>{if(ticket===serial)fail(error);}).finally(()=>{if(pending?.ticket===ticket)pending=null;});
    pending={key,ticket,promise};
    return promise;
  }};
}
