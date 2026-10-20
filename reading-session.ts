import type {ChunkAudio} from './speech-jobs.ts';
export interface PlaybackHandle {readonly currentTime:number;play(buffer:AudioBuffer,offset:number):Promise<void>;stop():void}
export interface SessionSnapshot {state:'paused'|'buffering'|'playing'|'error'|'ended';position:number;duration:number;approximate:boolean;bufferedUntil:number;index:number;error:string|null}
export interface SessionDependencies {synthesize(index:number,retry:boolean):Promise<ChunkAudio>;decode(audio:ChunkAudio):Promise<AudioBuffer>;createPlayback():PlaybackHandle}
interface Entry {audio?:ChunkAudio;buffer?:AudioBuffer;duration?:number;pending?:Promise<AudioBuffer>;error?:Error}
export class ReadingSession {
 readonly chunks:readonly string[];private deps:SessionDependencies;private entries:Entry[];private index=0;private offset=0;private fraction:number|null=null;private handle:PlaybackHandle|null=null;private token=0;private state:SessionSnapshot['state']='paused';private error:string|null=null;private disposed=false;private listeners=new Set<()=>void>();
 constructor(chunks:readonly string[],deps:SessionDependencies){if(!chunks.length)throw Error('Nothing to read');this.chunks=chunks;this.deps=deps;this.entries=chunks.map(()=>({}))}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private emit(){for(const listener of this.listeners)listener()}
 private duration(i:number){const e=this.entries[i]!;return e.duration??Math.max(1,this.chunks[i]!.length/12)}
 snapshot():SessionSnapshot {
  let duration=0,position=0,bufferedUntil=0,contiguous=true;
  for(let i=0;i<this.entries.length;i++){const d=this.duration(i);duration+=d;if(i<this.index)position+=d;if(contiguous&&this.entries[i]!.duration!==undefined)bufferedUntil+=d;else contiguous=false}
  if(this.index>=this.chunks.length)position=duration;
  else position+=this.handle?.currentTime??(this.fraction!==null?this.fraction*this.duration(this.index):this.offset);
  return {state:this.state,position:Math.max(0,Math.min(position,duration)),duration,approximate:this.entries.some(e=>e.duration===undefined),bufferedUntil,index:this.index,error:this.error};
 }
 private ensure(index:number,retry=false):Promise<AudioBuffer>{
  const e=this.entries[index]!;if(e.buffer)return Promise.resolve(e.buffer);if(e.pending)return e.pending;if(e.error&&!retry)return Promise.reject(e.error);
  e.error=undefined;
  e.pending=(async()=>{if(!e.audio)e.audio=await this.deps.synthesize(index,retry);const buffer=await this.deps.decode(e.audio);if(this.disposed)throw new DOMException('Disposed','AbortError');e.buffer=buffer;e.duration=buffer.duration;this.emit();return buffer})().catch(cause=>{e.error=cause instanceof Error?cause:Error(String(cause));throw e.error}).finally(()=>{e.pending=undefined});
  return e.pending;
 }
 play(){
  if(this.disposed)throw Error('Reading session disposed');if(this.state==='playing'||this.state==='buffering')return;
  if(this.state==='ended'){this.index=0;this.offset=0;this.fraction=null}
  const retry=this.state==='error'||Boolean(this.entries[this.index]?.error);this.error=null;this.state='buffering';const token=++this.token;this.emit();void this.run(token,retry);
 }
 private async run(token:number,retry:boolean){
  try{
   while(this.index<this.chunks.length){
    const index=this.index;this.state='buffering';this.emit();const buffer=await this.ensure(index,retry);retry=false;
    if(token!==this.token||this.disposed)return;
    if(this.fraction!==null){this.offset=this.fraction*buffer.duration;this.fraction=null}
    if(index+1<this.chunks.length)void this.ensure(index+1).catch(()=>{});
    // Keep original compressed bytes but release decoded buffers away from the playhead.
    for(let i=0;i<this.entries.length;i++)if(Math.abs(i-index)>1)this.entries[i]!.buffer=undefined;
    const playback=this.deps.createPlayback();this.handle=playback;this.state='playing';this.emit();await playback.play(buffer,this.offset);
    if(token!==this.token||this.disposed)return;
    this.handle=null;this.offset=0;this.index=index+1;
   }
   this.state='ended';this.emit();
  }catch(cause){
   if(token!==this.token||this.disposed)return;
   if(this.handle){this.offset=this.handle.currentTime;this.handle.stop();this.handle=null}
   this.error=cause instanceof Error?cause.message:String(cause);this.state='error';this.emit();
  }
 }
 pause(){this.token++;if(this.handle){this.offset=this.handle.currentTime;this.handle.stop();this.handle=null}this.state='paused';this.emit()}
 seek(seconds:number){
  if(!Number.isFinite(seconds))return;const resume=this.state==='playing'||this.state==='buffering';const total=this.snapshot().duration;this.pause();
  let remaining=Math.max(0,Math.min(seconds,total));this.error=null;this.fraction=null;
  for(let i=0;i<this.chunks.length;i++){const d=this.duration(i);if(remaining<d||i===this.chunks.length-1){this.index=i;if(this.entries[i]!.duration===undefined){this.fraction=remaining/d;this.offset=0}else this.offset=remaining;break}remaining-=d}
  this.emit();if(resume)this.play();
 }
 skip(delta:number){this.seek(this.snapshot().position+delta)}
 dispose(){this.pause();this.disposed=true;this.listeners.clear();for(const e of this.entries){e.audio=undefined;e.buffer=undefined}}
}
