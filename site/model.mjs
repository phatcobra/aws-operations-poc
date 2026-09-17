// Pure presentation logic: no network, browser state, credentials, or AWS SDK.
export const REPO = 'https://github.com/phatcobra/aws-operations-poc';
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const RESULTS = new Set(['success', 'recovered', 'exhausted', 'problem']);
const TRIGGERS = new Set(['automatic', 'verification', 'manual']);
const RECOVERY = new Set(['not_needed', 'retrying', 'recovered', 'exhausted']);
export const SCENARIOS = ['normal', 'transient', 'permanent'];

export function dateMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
export function proofUrl(value) {
  try {
    const u = new URL(value);
    if (u.origin === 'https://github.com' && /^\/phatcobra\/aws-operations-poc\/actions\/runs\/\d+$/.test(u.pathname) && !u.username && !u.password && !u.search && !u.hash) return u.href;
  } catch { /* An untrusted URL is never used. */ }
  return `${REPO}/actions`;
}
function validAttempt(row) {
  return row && Number.isInteger(row.attempt) && row.attempt >= 1 && row.attempt <= 3 && ['success', 'failure'].includes(row.status) && RECOVERY.has(row.recovery_state);
}
export function normalizeSnapshot(raw) {
  const data = raw && typeof raw === 'object' && [1, 2].includes(raw.schema_version) ? raw : {};
  const runs = Array.isArray(data.recent_runs) ? data.recent_runs : [];
  return {
    generated_at: dateMs(data.generated_at) === null ? null : data.generated_at,
    last_scheduled_run_at: dateMs(data.last_scheduled_run_at) === null ? null : data.last_scheduled_run_at,
    status: ['healthy', 'degraded', 'unknown'].includes(data.status) ? data.status : 'unknown',
    recent_runs: runs.filter(r => r && RESULTS.has(r.result) && TRIGGERS.has(r.trigger) && dateMs(r.at) !== null && Number.isInteger(r.attempts) && r.attempts >= 1 && r.attempts <= 3).slice(0, 12).map(r => ({
      at: r.at, result: r.result, trigger: r.trigger, attempts: r.attempts,
      latency_ms: typeof r.latency_ms === 'number' && Number.isFinite(r.latency_ms) && r.latency_ms >= 0 ? r.latency_ms : null,
      attempt_history: Array.isArray(r.attempt_history) ? r.attempt_history.filter(validAttempt).slice(0, 3).map(a => ({attempt:a.attempt, status:a.status, recovery_state:a.recovery_state})) : []
    })),
    proof: normalizeProof(data.proof)
  };
}
function normalizeProof(proof) {
  const p = proof && typeof proof === 'object' ? proof : {};
  const s = p.scenarios || {};
  const valid = p.state === 'verified' && p.source === 'evidence_artifact' && dateMs(p.verified_at) !== null &&
    s.normal?.result === 'success' && s.normal?.attempts === 1 &&
    s.transient?.result === 'recovered' && s.transient?.attempts === 2 &&
    s.permanent?.result === 'exhausted' && s.permanent?.attempts === 3;
  return {verified: valid, verified_at: valid ? p.verified_at : null, url: proofUrl(p.url)};
}
export function snapshotHealth(data, now = Date.now()) {
  const updated = dateMs(data.generated_at);
  const checked = dateMs(data.last_scheduled_run_at);
  if (updated === null || updated > now + 60000) return {state:'unknown', title:'Current status unknown', copy:'No usable published update is available. This does not prove the system is down.'};
  if (now - updated > STALE_AFTER_MS) return {state:'unknown', title:'A newer update is needed', copy:'This snapshot is over two hours old. Historical results remain available, but current health is unknown.'};
  if (data.status === 'degraded') return {state:'degraded', title:'Attention was needed', copy:'The published update recorded a late hourly check or an unsuccessful result. Inspect the evidence below.'};
  if (data.status !== 'healthy' || checked === null || checked > updated + 60000 || now - checked > STALE_AFTER_MS) return {state:'unknown', title:'Current status unknown', copy:'The available evidence cannot confirm a recent successful hourly check.'};
  return {state:'healthy', title:'Working at the last check', copy:'The latest recorded hourly job completed successfully. This is a snapshot—not a live health guarantee.'};
}
export function relativeTime(value, now = Date.now()) {
  const time = dateMs(value);
  if (time === null) return 'Not available';
  const elapsed = Math.max(0, Math.floor((now - time) / 60000));
  if (elapsed < 1) return 'Just now';
  if (elapsed < 60) return `${elapsed} min ago`;
  if (elapsed < 1440) return `${Math.floor(elapsed / 60)} hr ago`;
  return `${Math.floor(elapsed / 1440)} days ago`;
}
export function outcome(result) {
  return ({success:['Worked first time','✓'], recovered:['Recovered on a retry','↻'], exhausted:['Stopped at the safety limit','—'], problem:['Did not finish normally','!']})[result] || ['Unknown result','?'];
}
export function triggerName(trigger) {
  return ({automatic:'Hourly check',verification:'Deliberate deployment test',manual:'Manually started check'})[trigger] || 'Unknown trigger';
}
export function framesFor(name) {
  if (!SCENARIOS.includes(name)) throw new Error('Unknown simulation');
  const frames = [];
  const history = [];
  const push = (node, title, copy, say, phase = 'story') => frames.push({node,title,copy,say,phase,history:history.map(x => ({...x}))});
  const intro = {
    normal:['A straightforward job.','The service answers the first time. Follow one request from start to finish.'],
    transient:['One failure. Not the end.','The first request fails. A second try succeeds. Watch the recovery happen.'],
    permanent:['Knowing when to stop.','Every request fails. Watch the worker reach its limit without getting stuck.']
  }[name];
  push('worker', intro[0], intro[1], '“The job is checking the weather. The real test is what happens when something goes wrong.”', 'ready');
  push('schedule','It starts on its own.','Every hour, the schedule starts the worker. Nobody needs to press a button.', '“Think of an alarm clock: it starts this job once every hour.”');
  const total = name === 'normal' ? 1 : name === 'transient' ? 2 : 3;
  for (let n = 1; n <= total; n++) {
    push('weather', `Attempt ${n}: ask for the weather.`, n === 1 ? 'The worker asks a public weather service for New York City’s current temperature.' : 'The worker makes another attempt. A previous failure does not automatically end the job.', '“It asks for one piece of information. If it gets an answer, it can finish.”', 'request');
    const success = name !== 'permanent' && n === total;
    history.push({attempt:n,status:success?'success':'failure'});
    push('record', success ? 'An answer, and a record.' : `Attempt ${n} failed. It is recorded.`, success ? 'The worker records the successful result. No more attempts are needed.' : 'The failed attempt is written to the evidence trail. In the real test, this failure is deliberately simulated.', success ? '“We can inspect the result instead of just assuming it worked.”' : '“A failed attempt is still useful evidence. It is not hidden.”', success ? 'success' : 'failure');
    if (!success && n < total) push('worker','Wait. Then try again.', `The worker waits ${n === 1 ? 'half a second' : 'one second'} before its next attempt. This animation slows the process down so you can follow it.`, '“It gives a temporary problem time to clear, but it has a firm limit.”', 'retry');
  }
  push('worker', name === 'permanent' ? 'Three tries. Then stop.' : name === 'transient' ? 'Recovered. Automatically.' : 'Finished on the first try.', name === 'permanent' ? 'This run is over. There is no fourth attempt in the worker’s loop. The next hourly job is still scheduled.' : 'This run is complete. The evidence records the result, and the system waits for its next hourly job.', name === 'permanent' ? '“It cannot fix every problem. The important part is that it stops safely and leaves evidence.”' : '“The system did the job and left evidence. I did not have to intervene.”', 'done');
  return frames;
}
export function clampFrame(value, length) {
  return Math.max(0, Math.min(length - 1, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0));
}
