import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REPO, normalizeSnapshot, snapshotHealth, relativeTime, proofUrl, framesFor, clampFrame } from '../site/model.mjs';

const now = Date.parse('2026-09-17T20:00:00Z');
const base = {schema_version:2,generated_at:'2026-09-17T19:55:00Z',last_scheduled_run_at:'2026-09-17T19:35:00Z',status:'healthy',recent_runs:[],proof:{}};
for (const [name, expected] of [['normal',['success']],['transient',['failure','success']],['permanent',['failure','failure','failure']]]) {
  test(`${name}: exact bounded sequence, terminal state and narration`, () => {
    const frames = framesFor(name);
    assert.deepEqual(frames.at(-1).history.map(x=>x.status),expected);
    assert.equal(frames.at(-1).phase,'done');
    assert(frames.every(f=>f.say && f.copy && f.history.length <= 3));
    assert.equal(frames.filter(f=>f.phase === 'request').length,expected.length);
  });
}
test('unknown scenarios rejected; scrubber clamps bad and out-of-range values',()=>{
  assert.throws(()=>framesFor('arbitrary')); assert.equal(clampFrame(99,5),4);assert.equal(clampFrame(-4,5),0);assert.equal(clampFrame('bad',5),0);
});
test('recent healthy snapshot is explicitly historical',()=>{assert.equal(snapshotHealth(base,now).state,'healthy');assert.match(snapshotHealth(base,now).title,/last check/);});
test('stale snapshot cannot remain green',()=>assert.equal(snapshotHealth(base,now + 3*3600000).state,'unknown'));
test('stale scheduled run cannot remain green with fresh snapshot',()=>assert.equal(snapshotHealth({...base,last_scheduled_run_at:'2026-09-17T15:00:00Z'},now).state,'unknown'));
test('missing or future timestamps fail closed',()=>{
  for (const value of [null,'garbage','2026-09-18T00:00:00Z']) assert.equal(snapshotHealth({...base,generated_at:value},now).state,'unknown');
});
test('degraded evidence is not called healthy',()=>assert.equal(snapshotHealth({...base,status:'degraded'},now).state,'degraded'));
test('normalization drops unsupported schemas, records and sensitive fields',()=>{
  assert.equal(normalizeSnapshot({schema_version:7,status:'healthy'}).status,'unknown');
  const r=normalizeSnapshot({...base,recent_runs:[null,{at:base.generated_at,trigger:'automatic',result:'success',attempts:1,run_id:'private',latency_ms:null,attempt_history:[{attempt:1,status:'success',recovery_state:'not_needed',secret:'private'},{attempt:4,status:'failure'}]}]});
  assert.equal(r.recent_runs.length,1);assert.equal(r.recent_runs[0].latency_ms,null);assert.equal(r.recent_runs[0].attempt_history.length,1);assert(!JSON.stringify(r).includes('private'));
});
test('proof requires artifact source, exact outcomes and timestamp',()=>{
  const proof={state:'verified',source:'evidence_artifact',verified_at:base.generated_at,scenarios:{normal:{result:'success',attempts:1},transient:{result:'recovered',attempts:2},permanent:{result:'exhausted',attempts:3}}};
  assert(normalizeSnapshot({...base,proof}).proof.verified);
  assert(!normalizeSnapshot({...base,proof:{...proof,source:null}}).proof.verified);
  assert(!normalizeSnapshot({...base,proof:{...proof,scenarios:{}}}).proof.verified);
});
test('untrusted links never leave the exact POC action path',()=>{
  for(const url of ['javascript:alert(1)','https://github.com.evil.test/phatcobra/aws-operations-poc/actions/runs/1',`${REPO}/actions/runs/1?token=1`,'https://example.com'])assert.equal(proofUrl(url),`${REPO}/actions`);
  assert.equal(proofUrl(`${REPO}/actions/runs/123`),`${REPO}/actions/runs/123`);
});
test('missing times are not invented',()=>assert.equal(relativeTime(null,now),'Not available'));
const html=readFileSync(new URL('../site/index.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../site/experience.js',import.meta.url),'utf8');
test('all application DOM IDs exist once',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);assert.equal(ids.length,new Set(ids).size);
  for(const m of script.matchAll(/(?:\$|text)\('([^']+)'/g))assert(ids.includes(m[1]),`Missing ${m[1]}`);
});
test('public runtime has one GET-only same-origin data path and no HTML injection',()=>{
  assert.equal([...script.matchAll(/\bfetch\(/g)].length,1);assert(script.includes("fetch('./status.json'"));assert(script.includes("method:'GET'"));assert(script.includes("credentials:'omit'"));
  assert(!/innerHTML|insertAdjacentHTML|eval\(|WebSocket|sendBeacon|XMLHttpRequest/.test(script));assert(html.includes("connect-src 'self'"));assert(html.includes("form-action 'none'"));
});
test('page is local-asset-only and every external link is scoped to this POC',()=>{
  for(const [,url] of html.matchAll(/(?:src|href)="([^"]+)"/g))if(url.startsWith('https:'))assert(url.startsWith(`${REPO}/`)||url===REPO,url);
  for(const [,url] of html.matchAll(/(?:src|href)="(\.\/[^"?]+)(?:\?[^"]*)?"/g))if(url!=='./')assert.doesNotThrow(()=>readFileSync(new URL(`../site/${url.slice(2)}`,import.meta.url)));
});

test('DOM integration: playback, interruption, presentation, filters and failed fetch', async () => {
  class Element {
    constructor(){this.children=[];this.attrs={};this.listeners={};this.dataset={};this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.classList={toggle(){}};}
    setAttribute(k,v){this.attrs[k]=v;} getAttribute(k){return this.attrs[k];}
    addEventListener(k,fn){this.listeners[k]=fn;} click(){if(!this.disabled)this.listeners.click?.({target:this});}
    append(...els){this.children.push(...els);} replaceChildren(...els){this.children=els;} focus(){}
  }
  const ids=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(x=>[x[1],new Element()]));
  const buttons=(key,values)=>values.map(v=>{const el=new Element();el.dataset[key]=v;return el;});
  const scenarios=buttons('scenario',['normal','transient','permanent']);const components=buttons('component',['schedule','worker','weather','record']);const filters=buttons('filter',['all','automatic','verification']);
  const intervals=new Map();let intervalId=0;let fail=false;let requested=[];
  const real={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval};
  try {
    globalThis.document={getElementById:id=>ids[id],createElement:()=>new Element(),querySelectorAll:s=>({'[data-scenario]':scenarios,'[data-component]':components,'[data-filter]':filters})[s],addEventListener(){},hidden:false};
    globalThis.window={matchMedia:()=>({matches:false,addEventListener(){}})};
    globalThis.setInterval=(fn,ms)=>{intervals.set(++intervalId,{fn,ms});return intervalId;};globalThis.clearInterval=id=>intervals.delete(id);
    globalThis.fetch=async(url,opts)=>{requested.push({url,opts});if(fail)throw Error('offline');return {ok:true,json:async()=>({...base,recent_runs:[{at:base.generated_at,trigger:'automatic',result:'success',attempts:1,attempt_history:[{attempt:1,status:'success',recovery_state:'not_needed'}]}]})};};
    await import('../site/experience.js'); await new Promise(resolve=>setImmediate(resolve));
    assert.match(ids['scene-title'].textContent,/One failure/);assert.equal(ids['run-list'].children.length,1);
    ids.play.click();assert.match(ids.play.textContent,/Pause/);assert.equal([...intervals.values()].filter(x=>x.ms===2600).length,1);
    ids.next.click();assert.equal([...intervals.values()].filter(x=>x.ms===2600).length,0);
    scenarios[2].click();ids.scrub.value='99';ids.scrub.listeners.input({target:ids.scrub});assert.equal(ids['scene-title'].textContent,'Three tries. Then stop.');assert(ids.next.disabled);
    ids.restart.click();assert(ids.back.disabled);ids.presenter.click();assert.equal(ids.presenter.attrs['aria-pressed'],'true');assert.equal(ids['presenter-notes'].hidden,false);ids.play.click();assert.equal([...intervals.values()].filter(x=>x.ms===2600).length,0);
    components[1].click();assert.equal(ids.inspector.hidden,false);ids['inspector-close'].click();assert.equal(ids.inspector.hidden,true);
    filters[2].click();assert.equal(ids['receipt-title'].textContent,'No run selected');filters[0].click();assert.equal(ids['receipt-title'].textContent,'Worked first time');
    fail=true;await ids.refresh.listeners.click();assert.equal(ids['status-title'].textContent,'Evidence unavailable');assert(!ids.refresh.disabled);
    assert(requested.every(r=>r.url==='./status.json'&&r.opts.method==='GET'));
  } finally {Object.assign(globalThis,real);}
});
