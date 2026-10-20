import { randomUUID } from 'node:crypto';
export interface ChunkAudio { audioBase64:string; mimeType:string; cached:boolean }
export interface ChunkJobStatus { state:'pending'|'ready'|'error'; audio:ChunkAudio|null; message:string|null }
type Work=(signal:AbortSignal)=>Promise<ChunkAudio>;
interface Entry { id:string; key:string; work:Work; controller:AbortController; state:ChunkJobStatus['state']; audio:ChunkAudio|null; message:string|null; touched:number; running:boolean; bytes:number }
export class SpeechJobs {
 private entries=new Map<string,Entry>(); private keys=new Map<string,string>(); private queue:Entry[]=[]; private active=0; private disposed=false;
 private readonly concurrency:number; private readonly maxEntries:number; private readonly maxBytes:number; private readonly ttlMs:number; private readonly now:()=>number;
 constructor(options:{concurrency?:number;maxEntries?:number;maxBytes?:number;ttlMs?:number;now?:()=>number}={}) {
  this.concurrency=options.concurrency??2;this.maxEntries=options.maxEntries??128;this.maxBytes=options.maxBytes??64*1024*1024;this.ttlMs=options.ttlMs??30*60_000;this.now=options.now??Date.now;
 }
 private remove(e:Entry){this.entries.delete(e.id);if(this.keys.get(e.key)===e.id)this.keys.delete(e.key)}
 private prune(required=0){
  const completed=[...this.entries.values()].filter(e=>e.state!=='pending').sort((a,b)=>a.touched-b.touched);
  for(const e of completed)if(this.now()-e.touched>this.ttlMs)this.remove(e);
  let bytes=[...this.entries.values()].reduce((n,e)=>n+e.bytes,0);
  for(const e of completed){if(!this.entries.has(e.id))continue;if(this.entries.size+required<=this.maxEntries&&bytes<=this.maxBytes)break;bytes-=e.bytes;this.remove(e)}
 }
 request(key:string,work:Work):string {
  if(this.disposed)throw Error('Speech jobs disposed');this.prune();
  const known=this.keys.get(key);if(known){const e=this.entries.get(known)!;e.touched=this.now();return known}
  this.prune(1);if(this.entries.size>=this.maxEntries)throw Error('Speech service busy; try again shortly');
  const e:Entry={id:randomUUID(),key,work,controller:new AbortController(),state:'pending',audio:null,message:null,touched:this.now(),running:false,bytes:0};
  this.entries.set(e.id,e);this.keys.set(key,e.id);this.queue.push(e);queueMicrotask(()=>this.pump());return e.id;
 }
 status(id:string):ChunkJobStatus {
  this.prune();const e=this.entries.get(id);if(!e)throw Error('Speech job expired; prepare this fragment again');e.touched=this.now();return {state:e.state,audio:e.audio,message:e.message};
 }
 retry(id:string):string {
  if(this.disposed)throw Error('Speech jobs disposed');const e=this.entries.get(id);if(!e)throw Error('Speech job expired');
  if(e.state==='error'){e.state='pending';e.message=null;e.controller=new AbortController();e.touched=this.now();this.queue.push(e);queueMicrotask(()=>this.pump())}return id;
 }
 private pump(){
  if(this.disposed)return;
  while(this.active<this.concurrency&&this.queue.length){const e=this.queue.shift()!;this.active++;e.running=true;
   void Promise.resolve().then(()=>e.work(e.controller.signal)).then(audio=>{
    if(this.disposed)return;const bytes=Math.floor(audio.audioBase64.length*3/4);if(bytes>this.maxBytes)throw Error('Audio fragment exceeds cache capacity');
    e.audio=audio;e.bytes=bytes;e.state='ready';e.touched=this.now();this.prune();
   }).catch(cause=>{if(this.disposed)return;e.state='error';e.message=cause instanceof Error?cause.message:String(cause);e.touched=this.now()}).finally(()=>{e.running=false;this.active--;this.pump()});
  }
 }
 dispose(){this.disposed=true;this.queue=[];for(const e of this.entries.values())e.controller.abort(new DOMException('Plugin disposed','AbortError'));this.entries.clear();this.keys.clear()}
}
