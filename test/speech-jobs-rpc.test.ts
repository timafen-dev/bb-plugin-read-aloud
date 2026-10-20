import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
const settings={source:'openai',voice:'marin',rate:'1.2',openaiApiKey:'unit-test-placeholder',openaiModel:'gpt-4o-mini-tts'};

test('background RPC returns before synthesis and polling returns the cached audio',async t=>{
 let release!:(r:Response)=>void;let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Promise<Response>(r=>{release=r})});
 const {bb,harness}=createFakePluginHost({pluginId:'read-aloud',settings});t.after(()=>harness.lifecycle.dispose());await plugin(bb);
 const input={chunk:'Проверка фоновой озвучки.',threadId:null,format:'mp3'};
 const first=await harness.behavior.callRpc('requestChunk',input) as {jobId:string};
 assert.ok(first.jobId);assert.equal((await harness.behavior.callRpc('chunkStatus',first) as {state:string}).state,'pending');
 const same=await harness.behavior.callRpc('requestChunk',input) as {jobId:string};assert.equal(same.jobId,first.jobId);await tick();assert.equal(calls,1);
 release(new Response(new Uint8Array([73,68,51,1])));await tick();
 const ready=await harness.behavior.callRpc('chunkStatus',first) as {state:string;audio:{audioBase64:string}};
 assert.equal(ready.state,'ready');assert.ok(ready.audio.audioBase64);assert.equal(calls,1);
});

test('failed background job retains a retryable identity and status does not generate again',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:calls===1?429:200})});
 const {bb,harness}=createFakePluginHost({pluginId:'read-aloud',settings});t.after(()=>harness.lifecycle.dispose());await plugin(bb);
 const input={chunk:'Повторить только этот фрагмент.',threadId:null,format:'mp3'};
 const first=await harness.behavior.callRpc('requestChunk',input) as {jobId:string};await tick();
 assert.equal((await harness.behavior.callRpc('chunkStatus',first) as {state:string}).state,'error');assert.equal(calls,1);
 const retry=await harness.behavior.callRpc('requestChunk',{...input,retryJobId:first.jobId}) as {jobId:string};assert.equal(retry.jobId,first.jobId);await tick();assert.equal(calls,2);
});
