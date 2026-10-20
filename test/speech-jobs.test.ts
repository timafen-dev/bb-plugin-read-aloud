import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { SpeechJobs } from '../speech-jobs.ts';
const audio = (bytes=12) => ({audioBase64:Buffer.alloc(bytes).toString('base64'),mimeType:'audio/mpeg',cached:false});

test('request returns pending immediately, deduplicates, and caches original bytes',async()=>{
 const jobs=new SpeechJobs();let finish!:(a:ReturnType<typeof audio>)=>void;let calls=0;
 const id=jobs.request('same',async()=>{calls++;return new Promise(r=>{finish=r})});
 assert.equal(jobs.status(id).state,'pending');
 assert.equal(jobs.request('same',async()=>audio()),id);
 await tick();assert.equal(calls,1);const original=audio();finish(original);await tick();
 assert.deepEqual(jobs.status(id).audio,original);assert.equal(jobs.status(id).state,'ready');
 assert.equal(jobs.request('same',async()=>audio(3)),id);jobs.dispose();
});

test('failed jobs keep their identity and only retry on explicit retry',async()=>{
 const jobs=new SpeechJobs();let calls=0;
 const id=jobs.request('broken',async()=>{if(++calls===1)throw Error('service failed');return audio()});
 await tick();assert.equal(jobs.status(id).state,'error');assert.equal(calls,1);
 assert.equal(jobs.request('broken',async()=>audio()),id);assert.equal(calls,1);
 jobs.retry(id);await tick();assert.equal(jobs.status(id).state,'ready');assert.equal(calls,2);jobs.dispose();
});

test('synthesis has at most two concurrent workers',async()=>{
 const jobs=new SpeechJobs({concurrency:2});let active=0,max=0;const finish:Array<()=>void>=[];
 for(let i=0;i<5;i++)jobs.request(String(i),async()=>{max=Math.max(max,++active);await new Promise<void>(r=>finish.push(r));active--;return audio()});
 await tick();assert.equal(finish.length,2);finish.shift()!();await tick();assert.equal(max,2);
 jobs.dispose();for(const f of finish)f();
});

test('idle cache entries expire and completed entries are evicted under pressure',async()=>{
 let now=0;const jobs=new SpeechJobs({maxEntries:2,ttlMs:10,now:()=>now});
 const a=jobs.request('a',async()=>audio());await tick();
 const b=jobs.request('b',async()=>audio());await tick();now=20;
 const c=jobs.request('c',async()=>audio());await tick();
 assert.throws(()=>jobs.status(a),/expired/);assert.throws(()=>jobs.status(b),/expired/);assert.equal(jobs.status(c).state,'ready');jobs.dispose();
});

test('pending jobs are not silently evicted and oversized audio is rejected',async()=>{
 const jobs=new SpeechJobs({maxEntries:1,maxBytes:16});
 const id=jobs.request('a',async()=>new Promise(()=>{}));
 assert.throws(()=>jobs.request('b',async()=>audio()),/busy/);jobs.dispose();
 const small=new SpeechJobs({maxBytes:16});const big=small.request('big',async()=>audio(32));await tick();
 assert.equal(small.status(big).state,'error');small.dispose();
});

test('disposal aborts active jobs and prevents any queued work from starting',async()=>{
 const jobs=new SpeechJobs({concurrency:1});let signal:AbortSignal|undefined;let later=false;
 jobs.request('a',async s=>{signal=s;return new Promise((_r,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}))});
 jobs.request('b',async()=>{later=true;return audio()});await tick();jobs.dispose();await tick();
 assert.equal(signal?.aborted,true);assert.equal(later,false);assert.throws(()=>jobs.request('c',async()=>audio()),/disposed/);
});
