import { REPO, SCENARIOS, normalizeSnapshot, snapshotHealth, relativeTime, outcome, triggerName, framesFor, clampFrame } from './model.mjs?v=1';

const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
const make = (tag, value, className) => { const el = document.createElement(tag); if (value !== undefined) el.textContent = value; if (className) el.className = className; return el; };
const scenarios = [...document.querySelectorAll('[data-scenario]')];
const components = [...document.querySelectorAll('[data-component]')];
const filters = [...document.querySelectorAll('[data-filter]')];
let scenario = 'transient';
let frames = framesFor(scenario);
let position = 0;
let timer = null;
let presenting = false;
let filter = 'all';
let selected = 0;
let snapshot = normalizeSnapshot(null);
let loadFailed = false;
let inspected = null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const parts = {
  schedule: {label:'THE STARTING SIGNAL / EVENTBRIDGE',title:'A clock, not a person.',copy:'An enabled EventBridge rule starts the worker every hour. Fault injection is off by default for ordinary scheduled runs.',code:'ScheduleExpression: rate(1 hour)\nState: ENABLED\nMaximumRetryAttempts: 0 (EventBridge target)',file:'infra/template.yaml'},
  worker: {label:'THE EXECUTION / AWS LAMBDA',title:'One job. A bounded loop.',copy:'A Python function asks for the temperature. It makes at most three attempts, waiting briefly between failures. The function returns after success or exhaustion.',code:'Python 3.12 · 128 MB\nTimeout: 20 seconds\nMAX_ATTEMPTS: 3\nBackoff: 0.5s, then 1s',file:'src/app.py'},
  weather: {label:'THE DEPENDENCY / OPEN-METEO',title:'A deliberately ordinary task.',copy:'The workload requests the current temperature in New York City from a public, keyless weather API. No forecast or temperature is invented by this page.',code:'HTTPS GET · current.temperature_2m\nRequest timeout: 3 seconds\nNo API key required',file:'src/app.py'},
  record: {label:'THE EVIDENCE / DYNAMODB + CLOUDWATCH',title:'An inspectable attempt trail.',copy:'Each attempt is sent to DynamoDB and logged in CloudWatch. Database-write errors are logged separately; they do not crash the worker. The deployment verifier checks the actual stored sequence.',code:'attempt_number · status · recovery_state\nDynamoDB: run_id + timestamp\nCloudWatch: structured JSON events',file:'scripts/verify_live.py'}
};
function stop() { if (timer !== null) clearInterval(timer); timer = null; }
function renderScene() {
  const f = frames[position];
  text('scene-kicker', f.phase === 'ready' ? 'READY WHEN YOU ARE' : f.phase === 'done' ? 'SIMULATED OUTCOME' : `MOMENT ${position + 1} OF ${frames.length}`);
  text('scene-title', f.title); text('scene-description', f.copy); text('talking-point', f.say);
  text('moment', `${position + 1} / ${frames.length}`);
  $('scrub').max = String(frames.length - 1); $('scrub').value = String(position);
  $('scrub').setAttribute('aria-valuetext', `${position + 1} of ${frames.length}: ${f.title}`);
  $('back').disabled = position === 0; $('next').disabled = position === frames.length - 1;
  text('play', presenting || reducedMotion.matches ? (position === frames.length - 1 ? 'Replay the story ↻' : 'Next moment →') : timer !== null ? 'Pause story' : position === frames.length - 1 ? 'Replay the story ↻' : position === 0 ? 'Play the story →' : 'Continue story →');
  components.forEach(b => { b.classList.toggle('active', b.dataset.component === f.node); b.classList.toggle('failed', f.phase === 'failure' && b.dataset.component === 'record'); });
  const coordinates = {schedule:[175,108],worker:[270,108],weather:[455,108],record:[320,205]};
  $('packet').setAttribute('cx', coordinates[f.node][0]); $('packet').setAttribute('cy', coordinates[f.node][1]);
  $('attempts').replaceChildren(...[1,2,3].map(n => { const a = f.history.find(x => x.attempt === n); const li = make('li', a ? `${n} ${a.status === 'success' ? '✓' : '×'}` : `${n} —`, a?.status); li.setAttribute('aria-label', `Attempt ${n}: ${a?.status || 'not used yet'}`); return li; }));
}
function seek(value) { stop(); position = clampFrame(value, frames.length); renderScene(); }
function chooseScenario(name) {
  if (!SCENARIOS.includes(name)) return;
  stop(); scenario = name; frames = framesFor(name); position = 0;
  scenarios.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scenario === name)));
  renderScene();
}
function play() {
  if (timer !== null) { stop(); renderScene(); return; }
  if (position === frames.length - 1) position = 0;
  else if (presenting || reducedMotion.matches) { seek(position + 1); return; }
  if (presenting || reducedMotion.matches) { renderScene(); return; }
  timer = setInterval(() => { position += 1; if (position >= frames.length - 1) { position = frames.length - 1; stop(); } renderScene(); }, 2600);
  renderScene();
}
scenarios.forEach(b => b.addEventListener('click', () => chooseScenario(b.dataset.scenario)));
$('play').addEventListener('click', play);
$('back').addEventListener('click', () => seek(position - 1));
$('next').addEventListener('click', () => seek(position + 1));
$('restart').addEventListener('click', () => seek(0));
$('scrub').addEventListener('input', e => seek(e.target.value));
$('presenter').addEventListener('click', () => { stop(); presenting = !presenting; $('presenter').setAttribute('aria-pressed', String(presenting)); $('presenter-notes').hidden = !presenting; $('experience').classList.toggle('presenting', presenting); renderScene(); });
function closeInspector(returnFocus = true) {
  $('inspector').hidden = true;
  components.forEach(b => b.setAttribute('aria-expanded','false'));
  if (returnFocus && inspected) inspected.focus();
  inspected = null;
}
components.forEach(b => {
  b.setAttribute('aria-controls','inspector'); b.setAttribute('aria-expanded','false');
  b.addEventListener('click', () => {
    stop(); renderScene();
    if (inspected === b) { closeInspector(); return; }
    inspected = b; const part = parts[b.dataset.component];
    components.forEach(c => c.setAttribute('aria-expanded',String(c === b)));
    text('inspector-label',part.label); text('inspector-title',part.title); text('inspector-copy',part.copy); text('inspector-code',part.code);
    $('inspector-source').href = `${REPO}/blob/main/${part.file}`;
    $('inspector').hidden = false; $('inspector-title').focus({preventScroll:true});
  });
});
$('inspector-close').addEventListener('click', () => closeInspector());
document.addEventListener('keydown', e => { if (e.key === 'Escape') { stop(); renderScene(); closeInspector(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); renderScene(); } else renderHealth(); });
reducedMotion.addEventListener('change', () => { stop(); renderScene(); });

function absolute(value) { return value ? new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : 'Not available'; }
function renderHealth() {
  const health = loadFailed ? {state:'unknown',title:'Evidence unavailable',copy:'The latest file could not be loaded. The simulation still works; current system health is unknown.'} : snapshotHealth(snapshot);
  text('status-title', health.title); text('status-copy', health.copy);
  $('status-light').className = `status-light ${health.state}`;
  text('last-check', relativeTime(snapshot.last_scheduled_run_at)); $('last-check').title = absolute(snapshot.last_scheduled_run_at);
  text('snapshot-time', relativeTime(snapshot.generated_at)); $('snapshot-time').title = absolute(snapshot.generated_at);
}
function visibleRuns() { return snapshot.recent_runs.map((r,i) => ({...r,index:i})).filter(r => filter === 'all' || r.trigger === filter); }
function renderRuns() {
  const runs = visibleRuns();
  if (!runs.some(r => r.index === selected)) selected = runs[0]?.index ?? -1;
  $('run-list').replaceChildren();
  if (!runs.length) $('run-list').append(make('p',filter === 'all' ? 'No recorded runs are available in this snapshot.' : 'No runs of this type are in the published sample. This is not a complete history.','empty'));
  runs.forEach(r => {
    const [label,mark] = outcome(r.result); const row = make('button',undefined,'run-row'); row.type = 'button'; row.setAttribute('aria-pressed',String(r.index === selected)); row.setAttribute('aria-controls','receipt');
    const icon = make('span',mark,`result-mark ${r.result}`); icon.setAttribute('aria-hidden','true');
    const copy = make('span'); copy.append(make('strong',label),make('small',`${triggerName(r.trigger)} · ${r.attempts} ${r.attempts === 1 ? 'attempt' : 'attempts'}`));
    const time = make('time',relativeTime(r.at)); time.dateTime = r.at; time.title = absolute(r.at);
    row.append(icon,copy,time); row.addEventListener('click',() => { selected = r.index; for (const b of $('run-list').children) b.setAttribute('aria-pressed',String(b === row)); renderReceipt(); });
    $('run-list').append(row);
  });
  renderReceipt();
}
function renderReceipt() {
  const r = snapshot.recent_runs[selected]; $('receipt-attempts').replaceChildren();
  if (!r) { text('receipt-title','No run selected'); text('receipt-context','Choose another filter or refresh the published evidence.'); text('receipt-note','Missing evidence is not shown as a successful result.'); return; }
  text('receipt-title',outcome(r.result)[0]);
  text('receipt-context',`${triggerName(r.trigger)} · ${absolute(r.at)}`);
  r.attempt_history.forEach(a => { const li = make('li'); li.append(make('span',`Try ${a.attempt}`),make('span',a.status === 'success' ? 'Answer received · finished' : a.recovery_state === 'exhausted' ? 'Failed · retry limit reached' : 'Failed · another attempt allowed')); $('receipt-attempts').append(li); });
  if (!r.attempt_history.length) $('receipt-attempts').append(make('li','Attempt-by-attempt detail is not included in this snapshot.'));
  const timing = r.latency_ms === null ? 'Final-attempt timing unavailable.' : `Final attempt: ${r.latency_ms.toLocaleString()} ms. This excludes retry waits; it is not the total run duration.`;
  text('receipt-note',`${r.trigger === 'verification' ? 'A controlled deployment test, not a production incident. ' : ''}${timing}`);
}
function renderProof() {
  const proof = snapshot.proof;
  text('proof-title',proof.verified ? 'All three scenarios verified.' : 'Verified artifact not available.');
  text('proof-copy',proof.verified ? 'First-try success. Recovery on attempt two. A controlled stop after three failures. Each was checked against stored database history and matching logs.' : 'No complete, valid evidence artifact is attached to this snapshot. The simulation is not proof. Inspect the repository’s deployment runs for source evidence.');
  text('proof-date',proof.verified ? `Verified ${absolute(proof.verified_at)} · Historical deployment evidence` : '');
  $('proof-link').href = proof.url;
}
filters.forEach(b => b.addEventListener('click', () => { filter = b.dataset.filter; filters.forEach(c => c.setAttribute('aria-pressed',String(c === b))); renderRuns(); }));
async function loadEvidence() {
  $('refresh').disabled = true; text('refresh','Reading snapshot…');
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(),10000);
  try {
    // The only network operation performed by the application. GET only, same origin.
    const response = await fetch('./status.json', {method:'GET',cache:'no-store',credentials:'omit',signal:controller.signal});
    if (!response.ok) throw new Error('Snapshot request failed');
    snapshot = normalizeSnapshot(await response.json()); loadFailed = false;
  } catch { snapshot = normalizeSnapshot(null); loadFailed = true; }
  finally { clearTimeout(timeout); $('refresh').disabled = false; text('refresh','Refresh evidence ↻'); }
  renderHealth(); renderRuns(); renderProof();
}
$('refresh').addEventListener('click', loadEvidence);
renderScene(); loadEvidence();
// Age a once-healthy snapshot even if the visitor leaves this page open.
setInterval(() => renderHealth(), 60000);
