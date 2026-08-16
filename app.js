/* SayFirst — speak the point first. Voice goes to the Gemini API only when you stop recording (never stored); transcripts and rounds live in this device's IndexedDB */
'use strict';

const API = 'https://generativelanguage.googleapis.com';
const $ = id => document.getElementById(id);
const LOCALE = 'en-GB';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_REC_MS = 45_000;
const READY_S = 5;
const RECALL_H = 48;

/* ---------- Settings ---------- */
const SKEY = 'sayfirst-settings', KKEY = 'sayfirst-apikey';
const Settings = {
  load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SKEY)) || {}; } catch {}
    s.apiKey = (s.rememberKey !== false ? localStorage.getItem(KKEY) : null) || sessionStorage.getItem(KKEY) || '';
    return s;
  },
  save(s) {
    const { apiKey, ...rest } = s;
    localStorage.setItem(SKEY, JSON.stringify(rest));
    if (s.rememberKey) { localStorage.setItem(KKEY, apiKey); sessionStorage.removeItem(KKEY); }
    else { sessionStorage.setItem(KKEY, apiKey); localStorage.removeItem(KKEY); }
  },
  forgetKey() { localStorage.removeItem(KKEY); sessionStorage.removeItem(KKEY); },
};
let settings = Object.assign({ apiKey: '', model: DEFAULT_MODEL, lang: 'en', rememberKey: true, ctx: '', type: 'ask', modelPicked: false }, Settings.load());
if (!/^gemini/.test(settings.model)) { settings.model = DEFAULT_MODEL; settings.modelPicked = false; }
if (settings.apiKey && !/^AIza/.test(settings.apiKey)) settings.apiKey = '';
// MeetMemo lives on the same origin — reuse its Gemini key if we have none
if (!settings.apiKey) { const k = localStorage.getItem('protokoll-apikey'); if (k && /^AIza/.test(k)) { settings.apiKey = k; Settings.save(settings); } }

/* ---------- Storage (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sayfirst', 2);
      r.onupgradeneeded = e => { const db = e.target.result; if (!db.objectStoreNames.contains('rounds')) db.createObjectStore('rounds', { keyPath: 'id' }); };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  store(mode) { return DB.db.transaction('rounds', mode).objectStore('rounds'); },
  put(m) { return DB.req(DB.store('readwrite').put(m)); },
  all() { return DB.req(DB.store('readonly').getAll()); },
  get(id) { return DB.req(DB.store('readonly').get(id)); },
  del(id) { return DB.req(DB.store('readwrite').delete(id)); },
};

/* ---------- Gemini API ---------- */
const authHeaders = extra => ({ 'x-goog-api-key': settings.apiKey, ...extra });

async function apiError(r) {
  let msg = `HTTP ${r.status}`;
  try { msg = (await r.json()).error?.message || msg; } catch {}
  if ((r.status === 400 || r.status === 403) && /API key/i.test(msg)) msg = 'Invalid API key. Check it in Settings.';
  if (r.status === 429) msg = 'Rate limit reached. Try again in a moment.';
  if (r.status === 503) msg = 'Gemini is overloaded right now. Try again shortly.';
  return new Error(msg);
}

// Gemini's responseSchema is an OpenAPI subset: no additionalProperties, enum only on strings
function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    if (k === 'enum' && s.type !== 'string') continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

// One structured-output call. `parts` = user parts (text and/or inline audio). Returns parsed JSON.
async function askJSON(system, parts, schema, maxTokens = 8192) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: geminiSchema(schema), maxOutputTokens: maxTokens },
  };
  const r = await fetch(`${API}/v1beta/models/${settings.model}:generateContent`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
  });
  if (!r.ok) throw await apiError(r);
  const data = await r.json();
  if (data.promptFeedback?.blockReason) throw new Error('Request was blocked: ' + data.promptFeedback.blockReason);
  const c = data.candidates?.[0];
  if (c?.finishReason === 'MAX_TOKENS') throw new Error('Response was cut off. Try again.');
  const text = (c?.content?.parts || []).map(p => p.text || '').join('');
  try { return JSON.parse(text); } catch { throw new Error('Could not read the response. Try again.'); }
}
const T = text => ({ text });

async function fetchModels() {
  const r = await fetch(`${API}/v1beta/models?pageSize=200`, { headers: authHeaders() });
  if (!r.ok) throw await apiError(r);
  const data = await r.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(n => n.startsWith('gemini') && !/embedding|image|tts|live|audio-dialog|robotics|computer-use/.test(n))
    .sort();
}
function pickDefaultModel(models) {
  const stable = models
    .map(n => ({ n, m: n.match(/^gemini-(\d+)(?:\.(\d+))?-flash$/) }))
    .filter(x => x.m)
    .sort((a, b) => (+b.m[1] - +a.m[1]) || ((+b.m[2] || 0) - (+a.m[2] || 0)));
  return stable[0]?.n || models.find(n => /flash/.test(n)) || settings.model;
}

/* ---------- Message types & patterns ---------- */
const TYPES = {
  ask: {
    label: 'Ask', hint: 'You need something from someone — a decision, an approval, help.',
    point: 'the request itself (what you want them to do or decide)',
    steps: ['Request — what you want, in one sentence', 'Reason — the one fact that makes it necessary', 'Next step — what happens once they say yes'],
    frame: 'The user is about to walk over to (or ping) a colleague or team lead to ask for a decision, approval, or help. Their habit: a chronological story first, the actual request last or never.',
  },
  qa: {
    label: 'Q&A', hint: 'Someone asked you a question — in a meeting, in the corridor.',
    point: 'the direct answer (or the condition under which the answer holds)',
    steps: ['Answer — yes / no / it depends on X, first', 'Reason & risk — why, and what could go wrong', 'Next step — what you will do or need'],
    frame: 'The user was asked a question at work and has to answer on the spot. Their habit: explaining background before giving the answer.',
  },
  update: {
    label: 'Update', hint: 'A status, a result, a heads-up.',
    point: 'the current conclusion (where things stand, in one line)',
    steps: ['Conclusion — where it stands, one line', 'Impact — what it means for the listener', 'Ask / next step — what you need or will do'],
    frame: 'The user is giving a status update or reporting a result. Their habit: narrating what happened in order, so the listener has to work out the state themselves.',
  },
  pitch: {
    label: 'Pitch', hint: 'You are about to demo or present something you built.',
    point: 'the value (what problem this removes) — before any screen or feature',
    steps: ['Problem — who has what problem today', 'Value — what this does about it, not the clicks', 'What you want from the room — decision, feedback, adoption'],
    frame: 'The user is about to demo or present something they built. Their habit: narrating the screen without saying what problem it solves, so a colleague ends up summarising the value for them.',
  },
};

const ISSUES = [
  { key: 'late_point', en: 'The point came late (or never)', ko: '결론·요청이 늦게 나왔다 (또는 안 나왔다)' },
  { key: 'no_framing', en: 'No framing — listener didn\'t know why they were hearing it', ko: '프레이밍 없음 — 왜 듣는지 몰랐을 것' },
  { key: 'vague_reference', en: 'Vague words — "this", "it", "that thing"', ko: '지시어가 모호 — this, it, that thing' },
  { key: 'restarts', en: 'Restarts and run-ons — sentences rebuilt mid-way', ko: '문장 재시작·늘어짐' },
  { key: 'wrong_for_listener', en: 'Right content, wrong for this listener', ko: '내용은 맞는데 이 청자에게 안 맞음' },
  { key: 'none', en: 'Honestly, it was fine', ko: '솔직히 괜찮았다' },
  { key: 'unsure', en: 'I honestly can\'t tell', ko: '잘 모르겠다', selfOnly: true },
];
const issueLabel = k => { const i = ISSUES.find(x => x.key === k); return i ? (settings.lang === 'ko' ? i.ko : i.en) : k; };
function langName(l) { return l === 'ko' ? 'Korean (한국어)' : 'English'; }
const STAGE_LABEL = { first: 'First try', second: 'With the shape', final: 'Final — no hints', near: 'Variant · near', far: 'Variant · far', followup: 'Follow-up question', recall: 'Recall · 2 days later' };

/* ---------- Schemas & prompts ---------- */
const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string', description: 'Verbatim transcript in English, including fillers (um, uh, so, like, you know) and restarts. If the input is text, copy it as is.' },
    point_sentence: { type: 'integer', description: '1-based index of the sentence where the point first appears. 0 if it never appears.' },
    words_before_point: { type: 'integer', description: 'Number of words spoken before the point sentence begins. If the point never appears, the total word count.' },
    fillers: { type: 'integer', description: 'Count of filler words/sounds.' },
    restarts: { type: 'integer', description: 'Count of sentences abandoned and restarted mid-way, or run-ons chaining 3+ ideas.' },
    biggest_issue: { type: 'string', enum: ['late_point', 'no_framing', 'vague_reference', 'restarts', 'wrong_for_listener', 'none'] },
    note: { type: 'string', description: 'The coach\'s note for this stage — see instructions for length and content.' },
  },
  required: ['transcript', 'point_sentence', 'words_before_point', 'fillers', 'restarts', 'biggest_issue', 'note'],
  additionalProperties: false,
};

function analyzePrompt(round, stage, extra = {}) {
  const t = TYPES[round.type];
  const noteRule = {
    first: 'For this FIRST attempt the user has not yet self-diagnosed: keep the note to ONE short factual sentence about where the point appeared. No advice yet.',
    second: (extra.selfDiag === 'unsure'
      ? 'The user could not tell what the biggest problem in their first attempt was. Tell them in one plain sentence what it was.'
      : `The user self-diagnosed their first attempt as: "${issueLabel(extra.selfDiag)}". Say in one sentence whether that was the biggest problem or not (be honest).`) + ` Then give exactly ONE fix — the single change that would most improve THIS attempt — in one or two sentences, quoting their words. Nothing else.`,
    final: 'This is the FINAL attempt with all hints hidden. One sentence: did the point come first, and what is the one thing to carry into the real conversation.',
    near: 'This is a NEAR variant of the real case. One sentence: did they use the same shape, and where did it slip.',
    far: 'This is a FAR variant (different domain, same shape). One sentence: did the shape transfer, and where did it slip.',
    followup: 'This is an answer to an UNEXPECTED follow-up question. One sentence: was the direct answer first, and where did it slip.',
    recall: 'This is a RECALL two days later in a new situation. One sentence: did the shape survive, and where did it slip.',
  }[stage];
  const previous = round.attempts.length ? `\nEarlier attempts in this session (for context, do not re-grade them):\n${round.attempts.map(a => `- ${a.stage}: "${a.transcript}"`).join('\n')}` : '';
  return `You are a blunt, precise speaking coach for a non-native English speaker in an Operations role, whose colleagues are all non-native speakers too. Their diagnosed habit (from real transcripts): the point arrives after 30–40 seconds of story; no framing; vague pointers ("this", "it", "that stuff"); sentences restarted mid-way. Colleagues have to re-summarise what they meant.

${t.frame}
For a "${t.label}" message, "the point" means: ${t.point}.
The shape they are learning: ${t.steps.join(' → ')}.

Situation: ${extra.situation || round.situation}
Listener: ${extra.listener || round.listener || 'not specified'}
What they want: ${extra.want || round.want || 'not specified'}${extra.question ? `\nThe follow-up question they were asked: ${extra.question}` : ''}${previous}

Task: transcribe the attempt verbatim (if audio; keep fillers and restarts — do NOT clean it up), split into sentences, find the first sentence where the point appears, count words before it, count fillers, count restarts, and name the biggest issue.
Note rule: ${noteRule}
Write the note in ${langName(settings.lang)}; the transcript stays in English. Output JSON only.`;
}

const SITUATION_SCHEMA = {
  type: 'object',
  properties: {
    situation: { type: 'string', description: '2–4 sentences, second person, concrete names/numbers/dates, with a real judgment call inside.' },
    listener: { type: 'string', description: 'Who is listening and what they care about, one line.' },
    want: { type: 'string', description: 'What the user needs from the listener — a decision, an action, an answer. One line.' },
  },
  required: ['situation', 'listener', 'want'],
  additionalProperties: false,
};
function situationPrompt(type, recent) {
  const t = TYPES[type];
  return {
    system: `You write short, realistic workplace situations for a speaking drill. ${t.frame}
${settings.ctx ? `About the user's work (make it feel like theirs — real-sounding systems, numbers, roles; do not invent colleague names): ${settings.ctx}` : ''}
Rules: second person. Concrete. Slightly messy — a real judgment call inside. English only.`,
    user: `Write one new "${t.label}" situation.${recent.length ? `\nDo not reuse these recent themes:\n- ${recent.join('\n- ')}` : ''}`,
  };
}

const VARIANTS_SCHEMA = {
  type: 'object',
  properties: {
    near: SITUATION_SCHEMA,
    far: SITUATION_SCHEMA,
    followup: { type: 'string', description: 'One unexpected but realistic follow-up question a listener might fire back after the user\'s message about the ORIGINAL situation.' },
  },
  required: ['near', 'far', 'followup'],
  additionalProperties: false,
};
function variantsPrompt(round) {
  const t = TYPES[round.type];
  return {
    system: `You design transfer exercises for a speaking drill. The user just practised a "${t.label}" message with the shape: ${t.steps.join(' → ')}.
Make: (1) a NEAR variant — same workplace, same kind of listener, different facts, so the same shape applies; (2) a FAR variant — a different domain or a private-life setting where the same shape still applies (a landlord, a school, a doctor's office, a friend); (3) one unexpected follow-up question about the ORIGINAL situation.
Second person, concrete, English only. Do not invent colleague names.`,
    user: `Original situation: ${round.situation}\nListener: ${round.listener}\nWhat they want: ${round.want}`,
  };
}

const MODEL_SCHEMA = {
  type: 'object',
  properties: {
    model_line: { type: 'string', description: 'What the user could say, in their own content, following the shape. Plain words, short sentences (~15 words each), sounds like a warm clear person out loud. Not a press release.' },
    why: { type: 'string', description: 'One sentence: the single biggest structural difference from the user\'s final attempt.' },
  },
  required: ['model_line', 'why'],
  additionalProperties: false,
};
function modelPrompt(round) {
  const t = TYPES[round.type];
  const last = round.attempts.filter(a => ['first', 'second', 'final'].includes(a.stage)).slice(-1)[0];
  return {
    system: `You are the same speaking coach. Everyone in the user's workplace is a non-native English speaker: plain words, short sentences, no idioms. A one-sentence human opener that orients the room counts as framing, not story. Shape: ${t.steps.join(' → ')}. Write "why" in ${langName(settings.lang)}; the model line in English. JSON only.`,
    user: `Situation: ${round.situation}\nListener: ${round.listener}\nWhat they want: ${round.want}\n\nUser's latest attempt: ${last?.transcript || ''}`,
  };
}

const TAKE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Two to four sentences answering the user directly: right, partly right, or wrong — and why.' },
    revised_line: { type: 'string', description: 'If the user has a point, a revised model line. Empty string if no change is warranted.' },
  },
  required: ['reply', 'revised_line'],
  additionalProperties: false,
};
function takePrompt(round, modelLine, take) {
  return {
    system: `You are the same speaking coach who offered a model line. The user pushes back. If they are right (too stiff for a live room, misses a human opener, drops something they need), say so and revise. If they are wrong (they want the story back before the point), say so plainly and keep the line. Never flatter. Plain words, short sentences. Reply in ${langName(settings.lang)}; revised_line in English. JSON only.`,
    user: `Situation: ${round.situation}\nListener: ${round.listener}\nModel line: ${modelLine}\n\nUser's take: ${take}`,
  };
}

/* ---------- UI helpers ---------- */
function toast(msg, ms = 2600) {
  const t = $('toast');
  clearTimeout(t._timer); clearTimeout(t._hide);
  t.classList.remove('leaving');
  t.textContent = msg; t.hidden = false;
  t._timer = setTimeout(() => {
    t.classList.add('leaving');
    t._hide = setTimeout(() => { t.hidden = true; t.classList.remove('leaving'); }, 160);
  }, ms);
}
function swapLabel(btn, text) {
  btn.classList.add('swapping');
  setTimeout(() => { btn.textContent = text; btn.classList.remove('swapping'); }, 120);
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtDate(ts) { return new Date(ts).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }); }
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
const hit = a => a && a.metrics && a.metrics.pointSentence === 1;

const views = ['home', 'practice', 'detail', 'settings'];
function show(view) { views.forEach(v => $(`view-${v}`).hidden = v !== view); window.scrollTo(0, 0); }

/* Copy / clear tools */
const IC_COPY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const IC_CLEAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
function attachTools(id, { clear = true } = {}) {
  const el = $(id);
  const bar = document.createElement('div');
  bar.className = 'tools';
  const copy = document.createElement('button');
  copy.type = 'button'; copy.className = 'toolbtn'; copy.innerHTML = IC_COPY + '<span>Copy</span>';
  copy.onclick = async () => {
    const text = ('value' in el ? el.value : el.textContent).trim();
    if (!text) { toast('Nothing to copy'); return; }
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Could not copy'); }
  };
  bar.appendChild(copy);
  if (clear) {
    const clr = document.createElement('button');
    clr.type = 'button'; clr.className = 'toolbtn'; clr.innerHTML = IC_CLEAR + '<span>Clear</span>';
    clr.onclick = () => { if (el.readOnly) return; el.value = ''; el.focus(); };
    bar.appendChild(clr);
  }
  el.insertAdjacentElement('afterend', bar);
}

/* ---------- Home ---------- */
function computeStreak(rounds) {
  const days = new Set(rounds.map(r => dayKey(r.createdAt)));
  let streak = 0;
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}
function rate(list, pred) { const n = list.length; return n ? `${Math.round(100 * list.filter(pred).length / n)}%` : '–'; }

async function renderHome() {
  const rounds = (await DB.all()).sort((a, b) => b.createdAt - a.createdAt);
  const v2 = rounds.filter(r => r.v === 2);
  const streak = computeStreak(rounds);
  const today = rounds.filter(r => dayKey(r.createdAt) === dayKey(Date.now()));
  $('streakBadge').innerHTML = streak ? `<b>${streak}</b> day${streak === 1 ? '' : 's'}` : '';
  $('heroKicker').textContent = new Date().toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
  $('heroSub').textContent = today.length
    ? `${today.length} round${today.length === 1 ? '' : 's'} today. An email to answer, someone to ask, a status to give — one of those, out loud.`
    : 'An email to answer, someone to ask, a status to give. Pick one, say it out loud, get one fix. About four minutes.';

  // Type segment
  document.querySelectorAll('#typeSeg button').forEach(b => b.classList.toggle('active', b.dataset.type === settings.type));
  $('typeHint').textContent = TYPES[settings.type].hint;

  // Due recalls
  const due = v2.filter(r => r.recall && !r.recall.doneAt && r.recall.dueAt <= Date.now());
  $('dueBox').hidden = !due.length;
  $('dueList').innerHTML = '';
  due.forEach(r => {
    const b = document.createElement('button');
    b.className = 'hist-item due';
    b.innerHTML = `<span class="h-title">${esc(r.situation)}</span><span class="h-score">${TYPES[r.type].label}</span><span class="h-meta">practised ${fmtDate(r.createdAt)} · new situation, same shape</span>`;
    b.onclick = () => startRecall(r);
    $('dueList').appendChild(b);
  });

  // Stats
  const firsts = v2.map(r => r.attempts.find(a => a.stage === 'first')).filter(Boolean);
  const transfer = v2.flatMap(r => r.attempts.filter(a => ['near', 'far', 'followup', 'recall'].includes(a.stage)));
  const field = v2.filter(r => r.field && r.field.reasked != null);
  $('statsBox').hidden = !v2.length;
  $('statPractice').textContent = rate(firsts, hit);
  $('statTransfer').textContent = rate(transfer, hit);
  $('statField').textContent = rate(field, r => r.field.reasked === false);

  // History
  const list = $('historyList');
  list.innerHTML = '';
  $('emptyHistory').hidden = rounds.length > 0;
  rounds.slice(0, 40).forEach((r, i) => {
    const btn = document.createElement('button');
    btn.className = 'hist-item';
    btn.style.setProperty('--i', Math.min(i, 8));
    if (r.v === 2) {
      const f = r.attempts.find(a => a.stage === 'first'), l = r.attempts.filter(a => ['second', 'final'].includes(a.stage)).slice(-1)[0];
      const mark = a => a ? (hit(a) ? '●' : '○') : '·';
      btn.innerHTML = `<span class="h-title">${esc(r.situation)}</span>
        <span class="h-score">${mark(f)}${mark(l)}<small> point 1st</small></span>
        <span class="h-meta">${fmtDate(r.createdAt)} · ${TYPES[r.type].label}${r.quick ? ' · quick' : ''}${r.field?.reasked === false ? ' · field ✓' : r.field?.reasked === true ? ' · re-asked' : ''}${r.recall && !r.recall.doneAt ? ' · recall due ' + fmtDate(r.recall.dueAt) : ''}</span>`;
    } else {
      const tot = g => g ? g.criteria.reduce((a, c) => a + c.score, 0) : null;
      btn.innerHTML = `<span class="h-title">${esc(r.scenario)}</span><span class="h-score">${tot(r.grade)}${r.grade2 ? '→' + tot(r.grade2) : ''}<small>/8</small></span><span class="h-meta">${fmtDate(r.createdAt)} · v1</span>`;
    }
    btn.onclick = () => openDetail(r.id);
    list.appendChild(btn);
  });
  show('home');
}

/* ---------- Recorder ---------- */
let rec = null; // { mediaRecorder, chunks, stream, startedAt, timer, autoStop, resolve, reject }
let recTimer = null;

function fmtSec(s) { return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function setRecUI(state, msg) {
  const btn = $('btnRec');
  btn.dataset.state = state;
  btn.disabled = state === 'ready' || state === 'busy';
  $('recState').textContent = msg;
  $('speakCard').classList.toggle('recording', state === 'recording');
}
function pickMime() {
  const c = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
const blobToBase64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });

// Returns { audio: {mimeType, data}, seconds } or { text } — whichever the user produced
function capture(stage, { title, hint }) {
  return new Promise((resolve, reject) => {
    const card = $('speakCard');
    card.hidden = false;
    $('speakTitle').textContent = title;
    $('speakHint').textContent = hint;
    $('typedInput').value = '';
    $('typedBox').open = false;
    $('speakTimer').textContent = '';
    setRecUI('idle', 'Tap to record — up to 45 seconds');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    rec = { resolve, reject, chunks: [], mediaRecorder: null, stream: null, startedAt: 0 };
  });
}

async function startRecording() {
  if (!rec) return;
  // 5 s to think — no typing, no hints
  setRecUI('ready', 'Think. Don\'t write.');
  for (let i = READY_S; i > 0; i--) {
    $('speakTimer').textContent = `ready in ${i}`;
    await new Promise(r => setTimeout(r, 1000));
    if (!rec) return;
  }
  const cur = rec;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (rec !== cur) { stream.getTracks().forEach(t => t.stop()); return; }
    const mime = pickMime();
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    cur.stream = stream; cur.mediaRecorder = mr; cur.chunks = []; cur.startedAt = Date.now();
    mr.ondataavailable = e => { if (e.data && e.data.size) cur.chunks.push(e.data); };
    mr.onstop = async () => {
      clearInterval(recTimer);
      stream.getTracks().forEach(t => t.stop());
      if (cur.abandoned || rec !== cur) return;
      const seconds = Math.round((Date.now() - cur.startedAt) / 1000);
      const blob = new Blob(cur.chunks, { type: mr.mimeType || mime || 'audio/mp4' });
      if (!blob.size) { setRecUI('idle', 'Nothing recorded — try again'); return; }
      setRecUI('busy', 'Listening back…');
      try {
        const data = await blobToBase64(blob);
        if (rec !== cur) return;
        rec = null;
        cur.resolve({ audio: { mimeType: (blob.type || 'audio/mp4').split(';')[0], data }, seconds });
      } catch (e) { setRecUI('idle', 'Could not read the recording — try again'); }
    };
    mr.start(250);
    setRecUI('recording', 'Recording — tap to stop');
    recTimer = setInterval(() => {
      const s = Math.round((Date.now() - cur.startedAt) / 1000);
      $('speakTimer').textContent = fmtSec(s);
      $('speakTimer').classList.toggle('over', s >= 40);
      if (s * 1000 >= MAX_REC_MS) stopRecording();
    }, 250);
  } catch (e) {
    setRecUI('idle', 'Microphone not available here — dictate or type below');
    $('typedBox').open = true;
    $('typedInput').focus();
  }
}
function stopRecording() {
  if (rec?.mediaRecorder && rec.mediaRecorder.state !== 'inactive') rec.mediaRecorder.stop();
}
function sendTyped() {
  const text = $('typedInput').value.trim();
  if (!text) { toast('Say something first'); return; }
  if (!rec) return;
  const r = rec; rec = null;
  r.abandoned = true;
  clearInterval(recTimer);
  try { if (r.mediaRecorder?.state === 'recording') r.mediaRecorder.stop(); } catch {}
  r.stream?.getTracks().forEach(t => t.stop());
  setRecUI('busy', 'Reading…');
  r.resolve({ text });
}
function cancelCapture() {
  clearInterval(recTimer);
  if (rec) {
    const r = rec; rec = null; r.abandoned = true;
    try { if (r.mediaRecorder?.state === 'recording') r.mediaRecorder.stop(); } catch {}
    r.stream?.getTracks().forEach(t => t.stop());
    r.reject(new Error('cancelled'));
  }
  $('speakCard').hidden = true;
}

/* ---------- Session flow ---------- */
let round = null;      // in-progress round
let sessionToken = 0;  // bumps when the user leaves; running flow checks it

function newRound(type, situation, listener, want, src) {
  return { v: 2, id: crypto.randomUUID(), createdAt: Date.now(), type, src, situation, listener, want,
    attempts: [], selfDiag: null, modelLine: null, why: null, take: '', takeReply: null,
    variants: null, recall: null, field: null };
}

async function analyze(stage, input, extra) {
  const parts = input.audio
    ? [{ inline_data: { mime_type: input.audio.mimeType, data: input.audio.data } }, T('Analyse this recording as instructed.')]
    : [T(`The user's attempt (typed or dictated):\n${input.text}`)];
  const raw = await askJSON(analyzePrompt(round, stage, extra), parts, ANALYZE_SCHEMA);
  const int = (v, d = 0) => Number.isFinite(+v) ? Math.max(0, Math.round(+v)) : d;
  return {
    stage, at: Date.now(), input: input.audio ? 'audio' : 'text', transcript: String(raw.transcript || input.text || ''),
    metrics: { pointSentence: int(raw.point_sentence), wordsBeforePoint: int(raw.words_before_point), fillers: int(raw.fillers), restarts: int(raw.restarts), seconds: input.seconds || null },
    issue: ISSUES.some(i => i.key === raw.biggest_issue) ? raw.biggest_issue : 'none',
    note: String(raw.note || ''),
    ctx: extra && (extra.situation || extra.question) ? { situation: extra.situation, listener: extra.listener, want: extra.want, question: extra.question } : null,
  };
}

function metricsHtml(m) {
  const pt = m.pointSentence === 0 ? '<b class="bad">point never came</b>' : m.pointSentence === 1 ? '<b class="good">point in sentence 1</b>' : `<b class="bad">point in sentence ${m.pointSentence}</b>`;
  return `<div class="metrics">${pt} · ${m.wordsBeforePoint} words before it · fillers ${m.fillers} · restarts ${m.restarts}${m.seconds ? ` · ${m.seconds}s` : ''}</div>`;
}
function attemptCard(a, { showNote = true, ctx = null } = {}) {
  const el = document.createElement('div');
  el.className = 'card attempt';
  el.innerHTML = `<div class="card-head"><h3>${esc(STAGE_LABEL[a.stage] || a.stage)}</h3><span class="pill pill-soft">${a.input === 'audio' ? 'voice' : 'text'}</span></div>
    ${ctx ? `<p class="hint ctx">${esc(ctx)}</p>` : ''}
    <p class="transcript">${esc(a.transcript)}</p>
    ${metricsHtml(a.metrics)}
    ${showNote && a.note ? `<p class="note">${esc(a.note)}</p>` : ''}`;
  return el;
}

// One capture → analyse → card. Handles the "busy" UI and errors (retry loop stays on the same stage).
async function attempt(stage, ui, extra) {
  const myToken = sessionToken;
  for (;;) {
    let input;
    try { input = await capture(stage, ui); } catch { return null; }   // cancelled
    if (myToken !== sessionToken) return null;
    try {
      const a = await analyze(stage, input, extra);
      if (myToken !== sessionToken) return null;
      $('speakCard').hidden = true;
      round.attempts.push(a);
      const card = attemptCard(a, { showNote: stage !== 'first', ctx: extra?.question ? `Q: ${extra.question}` : extra?.situation ? extra.situation : null });
      $('attempts').appendChild(card);
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return a;
    } catch (e) {
      toast(e.message, 5000);
      setRecUI('idle', 'Something went wrong — record again');
      // loop: same stage again
    }
  }
}

function setStage(text) { $('stagePill').textContent = text; }

async function startSession(type, situation, listener, want, src) {
  if (!settings.apiKey) { toast('Add your Gemini API key in Settings first'); renderSettings(); return; }
  round = newRound(type, situation, listener, want, src);
  sessionToken++;
  const t = TYPES[type];
  $('typePill').textContent = t.label;
  $('briefSit').textContent = situation; $('briefListener').textContent = listener || '—'; $('briefWant').textContent = want || '—';
  $('attempts').innerHTML = '';
  ['diagCard', 'patternCard', 'afterFinal', 'revealOut', 'takeOut', 'takeLine', 'speakCard'].forEach(id => $(id).hidden = true);
  $('takeInput').value = ''; $('modelLine').textContent = ''; $('modelWhy').textContent = '';
  $('btnExtend').hidden = false; $('btnExtend').disabled = false; $('btnExtend').textContent = 'Extend: 2 variants + a follow-up'; $('btnReveal').textContent = 'Reveal a model line';
  $('briefCard').classList.remove('dim');
  show('practice');
  runFlow();
}

async function runFlow() {
  const my = sessionToken;
  const t = TYPES[round.type];

  // 1) First attempt — no hints
  setStage('1 · speak');
  const first = await attempt('first', { title: 'Say it — as you would, right now', hint: 'No notes, no typing. Five seconds to think, then talk to the listener above.' });
  if (!first || my !== sessionToken) return;

  // 2) Self-diagnosis
  setStage('2 · your call');
  const selfDiag = await new Promise(res => {
    const box = $('diagList'); box.innerHTML = '';
    ISSUES.forEach(i => { const b = document.createElement('button'); b.className = 'diagbtn'; b.textContent = issueLabel(i.key); b.onclick = () => { box.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); res(i.key); }; box.appendChild(b); });
    $('diagCard').hidden = false; $('diagCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  if (my !== sessionToken) return;
  round.selfDiag = selfDiag;

  // 3) Pattern
  setStage('3 · the shape');
  $('patternTitle').textContent = `The shape for a ${t.label.toLowerCase()}`;
  $('patternSteps').innerHTML = t.steps.map((s, i) => `<div class="pstep"><span>${i + 1}</span><p>${esc(s)}</p></div>`).join('');
  $('patternHint').textContent = 'Not a script — three slots. Fill them with your own words, out loud.';
  $('patternCard').hidden = false; $('patternCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const choice = await new Promise(res => { $('btnSpeakAgain').onclick = () => res('speak'); $('btnSkipToModel').onclick = () => res('skip'); });
  if (my !== sessionToken) return;

  if (choice === 'skip') {
    // Time-poor path: no second/final attempt. The recall in two days matters more on these days.
    round.quick = true;
    setStage('quick · model line');
    $('patternCard').hidden = true; $('diagCard').hidden = true;
    $('afterFinal').hidden = false;
    $('btnExtend').hidden = true;
    await reveal();
    $('afterFinal').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await DB.put(round);
    return;
  }

  // 4) Second attempt — one fix
  setStage('4 · again, with the shape');
  const second = await attempt('second', { title: 'Say it again with the shape', hint: `${t.steps.map(s => s.split(' — ')[0]).join(' → ')}. Same listener, same want.` }, { selfDiag });
  if (!second || my !== sessionToken) return;

  // 5) Final — hide everything
  setStage('5 · final, no hints');
  $('patternCard').hidden = true; $('diagCard').hidden = true;
  $('briefCard').classList.add('dim');
  document.querySelectorAll('#attempts .attempt').forEach(c => c.classList.add('collapsed'));
  const fin = await attempt('final', { title: 'Last time — everything hidden', hint: 'This is the version you will actually use. Go.' });
  if (!fin || my !== sessionToken) return;
  document.querySelectorAll('#attempts .attempt').forEach(c => c.classList.remove('collapsed'));

  // 6) Optional: reveal / extend, then done
  setStage('done · optional extras');
  $('afterFinal').hidden = false; $('afterFinal').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await DB.put(round); // save progress so a crash doesn't lose the session
}

async function reveal() {
  const btn = $('btnReveal');
  if (btn.disabled) return;
  if (round.modelLine) { $('revealOut').hidden = false; return; }
  btn.disabled = true; swapLabel(btn, 'Writing…');
  try {
    const p = modelPrompt(round);
    const m = await askJSON(p.system, [T(p.user)], MODEL_SCHEMA, 4096);
    round.modelLine = String(m.model_line || ''); round.why = String(m.why || '');
    $('modelLine').textContent = round.modelLine; $('modelWhy').textContent = round.why;
    $('revealOut').hidden = false;
    await DB.put(round);
  } catch (e) { toast(e.message, 5000); }
  finally { btn.disabled = false; swapLabel(btn, 'Model line'); }
}

async function askTake() {
  const take = $('takeInput').value.trim();
  const btn = $('btnTake');
  if (!take || !round?.modelLine) { toast('Write your take first'); return; }
  if (btn.disabled) return;
  btn.disabled = true; swapLabel(btn, 'Thinking…');
  try {
    const p = takePrompt(round, round.modelLine, take);
    const t = await askJSON(p.system, [T(p.user)], TAKE_SCHEMA, 4096);
    round.take = take; round.takeReply = { reply: String(t.reply || ''), revised_line: String(t.revised_line || '').trim() };
    $('takeReply').textContent = round.takeReply.reply;
    $('takeLine').textContent = round.takeReply.revised_line;
    $('takeLine').hidden = !round.takeReply.revised_line;
    $('takeOut').hidden = false;
    await DB.put(round);
  } catch (e) { toast(e.message, 5000); }
  finally { btn.disabled = false; swapLabel(btn, 'Ask'); }
}

async function extend() {
  const btn = $('btnExtend');
  if (btn.disabled) return;
  const my = sessionToken;
  btn.disabled = true; swapLabel(btn, 'Building variants…');
  try {
    if (!round.variants) {
      const p = variantsPrompt(round);
      round.variants = await askJSON(p.system, [T(p.user)], VARIANTS_SCHEMA, 4096);
      await DB.put(round);
    }
  } catch (e) { toast(e.message, 5000); btn.disabled = false; swapLabel(btn, 'Extend: 2 variants + a follow-up'); return; }
  btn.hidden = true;
  const v = round.variants;
  setStage('extend · near variant');
  const near = await attempt('near', { title: 'Near variant — same shape, new facts', hint: v.near.situation + ` (Listener: ${v.near.listener}. You want: ${v.near.want})` }, { situation: v.near.situation, listener: v.near.listener, want: v.near.want });
  if (!near || my !== sessionToken) return;
  setStage('extend · far variant');
  const far = await attempt('far', { title: 'Far variant — same shape, different world', hint: v.far.situation + ` (Listener: ${v.far.listener}. You want: ${v.far.want})` }, { situation: v.far.situation, listener: v.far.listener, want: v.far.want });
  if (!far || my !== sessionToken) return;
  setStage('extend · follow-up');
  const fu = await attempt('followup', { title: 'They fire back a question — answer it', hint: `"${v.followup}" — answer first, then the reason.` }, { question: v.followup });
  if (!fu || my !== sessionToken) return;
  setStage('done');
  await DB.put(round);
  $('afterFinal').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function finishSession() {
  if (!round) { renderHome(); return; }
  if (!round.recall) round.recall = { dueAt: Date.now() + RECALL_H * 3600_000, doneAt: null, situation: null };
  await DB.put(round);
  round = null; sessionToken++;
  toast('Saved. Now go say it for real.');
  renderHome();
}

/* Recall: two days later, one far-ish variant, one attempt */
async function startRecall(r) {
  if (!settings.apiKey) { renderSettings(); return; }
  round = r; sessionToken++;
  const my = sessionToken;
  const t = TYPES[r.type];
  $('typePill').textContent = t.label; setStage('recall');
  $('briefSit').textContent = r.situation; $('briefListener').textContent = r.listener || '—'; $('briefWant').textContent = r.want || '—';
  $('attempts').innerHTML = '';
  ['diagCard', 'patternCard', 'afterFinal', 'speakCard'].forEach(id => $(id).hidden = true);
  $('briefCard').classList.add('dim');
  show('practice');
  let v;
  $('speakCard').hidden = false; $('speakTitle').textContent = 'Two days later'; $('speakHint').textContent = 'Writing a new situation…'; setRecUI('busy', '');
  try {
    // a fresh far variant each recall
    const p = variantsPrompt(round); const nv = await askJSON(p.system, [T(p.user)], VARIANTS_SCHEMA, 4096);
    v = nv.far;
  } catch (e) { toast(e.message, 5000); renderHome(); return; }
  if (my !== sessionToken) return;
  const a = await attempt('recall', { title: 'Two days later — same shape, new situation', hint: v.situation + ` (Listener: ${v.listener}. You want: ${v.want})` }, { situation: v.situation, listener: v.listener, want: v.want });
  if (!a || my !== sessionToken) return;
  round.recall = { dueAt: round.recall?.dueAt || Date.now(), doneAt: Date.now(), situation: v.situation };
  await DB.put(round);
  round = null; sessionToken++;
  toast(hit(a) ? 'Shape survived. Saved.' : 'Saved — the shape slipped; look at the note.');
  setTimeout(renderHome, 1800);
}

/* Generated situation → same flow */
async function generateSituation() {
  if (!settings.apiKey) { renderSettings(); return; }
  const btn = $('btnGenerate');
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Writing…';
  try {
    const recent = (await DB.all()).filter(r => r.v === 2 && r.type === settings.type).sort((a, b) => b.createdAt - a.createdAt).slice(0, 8).map(r => r.situation.slice(0, 100));
    const p = situationPrompt(settings.type, recent);
    const s = await askJSON(p.system, [T(p.user)], SITUATION_SCHEMA, 4096);
    $('sitInput').value = s.situation; $('listenerInput').value = s.listener; $('wantInput').value = s.want;
    toast('Filled in — read it once, then get ready to speak');
  } catch (e) { toast(e.message, 5000); }
  finally { btn.disabled = false; btn.textContent = old; }
}

/* ---------- Detail ---------- */
let currentDetail = null;
async function openDetail(id) {
  const r = await DB.get(id);
  if (!r) return renderHome();
  currentDetail = r;
  const body = $('detailBody');
  if (r.v === 2) {
    body.innerHTML = `
      <div class="practice-head"><span class="pill">${TYPES[r.type].label}</span><span class="pill pill-soft">${r.src === 'generated' ? 'generated' : 'real'}</span></div>
      <p class="detail-meta">${new Date(r.createdAt).toLocaleString(LOCALE)}</p>
      <div class="card brief"><p class="brief-line"><span class="brief-k">Situation</span><span>${esc(r.situation)}</span></p><p class="brief-line"><span class="brief-k">Listener</span><span>${esc(r.listener || '—')}</span></p><p class="brief-line"><span class="brief-k">You want</span><span>${esc(r.want || '—')}</span></p></div>
      ${r.selfDiag ? `<p class="hint">Your call after the first try: <b>${esc(issueLabel(r.selfDiag))}</b></p>` : ''}
      <div id="detailAttempts"></div>
      ${r.modelLine ? `<div class="card"><h3>Model line</h3><blockquote class="model-line">${esc(r.modelLine)}</blockquote><p class="hint">${esc(r.why)}</p>${r.takeReply ? `<p class="hint"><b>Your take:</b> ${esc(r.take)}</p><p class="take-reply">${esc(r.takeReply.reply)}</p>${r.takeReply.revised_line ? `<blockquote class="model-line">${esc(r.takeReply.revised_line)}</blockquote>` : ''}` : ''}</div>` : ''}
      ${r.field ? `<div class="card"><h3>Field result</h3><p>${r.field.reasked ? 'Someone asked "so what do you need?"' : 'Nobody had to ask what you needed'} · ${r.field.decisionClear ? 'decision clear' : 'decision unclear'}${r.field.note ? ` · ${esc(r.field.note)}` : ''}</p></div>` : ''}`;
    const da = body.querySelector('#detailAttempts');
    r.attempts.forEach(a => da.appendChild(attemptCard(a, { showNote: true, ctx: a.ctx?.question ? `Q: ${a.ctx.question}` : a.ctx?.situation || null })));
    $('fieldCard').hidden = false;
    document.querySelectorAll('#reaskSeg button').forEach(b => b.classList.toggle('active', r.field && String(r.field.reasked) === (b.dataset.v === 'yes' ? 'true' : 'false')));
    document.querySelectorAll('#clearSeg button').forEach(b => b.classList.toggle('active', r.field && String(r.field.decisionClear) === (b.dataset.v === 'yes' ? 'true' : 'false')));
    $('fieldNote').value = r.field?.note || '';
  } else {
    const tot = g => g ? g.criteria.reduce((a, c) => a + c.score, 0) : null;
    const crit = g => g.criteria.map(c => `<div class="crit"><span class="crit-mark s${c.score}">${c.score}</span><div><strong>${esc(c.key)}</strong><p>${esc(c.note)}</p></div></div>`).join('');
    body.innerHTML = `<p class="detail-meta">${new Date(r.createdAt).toLocaleString(LOCALE)} · v1 round</p>
      <div class="card"><h3>Scenario</h3><p class="detail-q">${esc(r.scenario)}</p></div>
      <div class="card"><div class="card-head"><h3>First attempt</h3><span class="score">${tot(r.grade)}<small>/8</small></span></div><div class="detail-answer">${esc(r.answer)}</div><div class="criteria">${crit(r.grade)}</div></div>
      <div class="card"><h3>Model line</h3><blockquote class="model-line">${esc(r.grade.model_line)}</blockquote></div>
      ${r.grade2 ? `<div class="card"><div class="card-head"><h3>Rewrite</h3><span class="score">${tot(r.grade2)}<small>/8</small></span></div><div class="detail-answer">${esc(r.rewrite)}</div></div>` : ''}`;
    $('fieldCard').hidden = true;
  }
  show('detail');
}
async function saveField() {
  if (!currentDetail || currentDetail.v !== 2) return;
  const re = document.querySelector('#reaskSeg button.active')?.dataset.v, cl = document.querySelector('#clearSeg button.active')?.dataset.v;
  if (!re || !cl) { toast('Answer both questions'); return; }
  currentDetail.field = { reasked: re === 'yes', decisionClear: cl === 'yes', note: $('fieldNote').value.trim(), at: Date.now() };
  await DB.put(currentDetail);
  toast('Saved — that\'s the number that matters');
  renderHome();
}

/* ---------- Backup ---------- */
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function backupAll() {
  const rounds = await DB.all();
  if (!rounds.length) { toast('Nothing to export yet'); return; }
  const payload = { app: 'SayFirst', version: 2, exportedAt: new Date().toISOString(), rounds };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const d = new Date();
  const name = `sayfirst-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  try {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'SayFirst history' }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  downloadBlob(blob, name);
}
async function restoreFromFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Not a valid backup file'); return; }
  const list = Array.isArray(data?.rounds) ? data.rounds : null;
  if (!list) { toast('Not a SayFirst backup'); return; }
  let n = 0;
  for (const r of list) { if (r?.id && (r.v === 2 || r.grade)) { await DB.put(r); n++; } }
  toast(`Restored ${n} round${n === 1 ? '' : 's'}`);
  renderHome();
}

/* ---------- Settings ---------- */
function fillModelSelect(models, selected = settings.model) {
  const set = new Set([selected, ...models]);
  $('modelSel').innerHTML = [...set].map(m => `<option ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('');
}
function renderSettings() {
  $('apiKeyInput').value = settings.apiKey;
  $('rememberKey').checked = settings.rememberKey !== false;
  fillModelSelect([settings.model]);
  $('ctxInput').value = settings.ctx || '';
  document.querySelectorAll('#langSeg button').forEach(b => b.classList.toggle('active', b.dataset.lang === settings.lang));
  show('settings');
}

/* ---------- Bind ---------- */
function bind() {
  $('btnHome').onclick = () => {
    if (round && round.attempts?.length && !round.recall && !confirm('Leave this session? Progress so far is kept.')) return;
    if (round && round.attempts?.length) DB.put(round);
    cancelCapture(); round = null; sessionToken++; renderHome();
  };
  $('btnSettings').onclick = renderSettings;

  $('typeSeg').onclick = e => {
    if (!e.target.dataset.type) return;
    settings.type = e.target.dataset.type; Settings.save(settings);
    document.querySelectorAll('#typeSeg button').forEach(b => b.classList.toggle('active', b.dataset.type === settings.type));
    $('typeHint').textContent = TYPES[settings.type].hint;
  };
  $('btnStart').onclick = () => {
    const sit = $('sitInput').value.trim(), lis = $('listenerInput').value.trim(), want = $('wantInput').value.trim();
    if (!sit) { toast('Describe the situation first'); $('sitInput').focus(); return; }
    if (!want) { toast('What do you want from them? That is the point.'); $('wantInput').focus(); return; }
    startSession(settings.type, sit, lis, want, 'real');
    $('sitInput').value = ''; $('listenerInput').value = ''; $('wantInput').value = '';
  };
  $('btnGenerate').onclick = generateSituation;

  $('btnRec').onclick = () => { const s = $('btnRec').dataset.state; if (s === 'recording') stopRecording(); else if (s === 'idle') startRecording(); };
  $('btnTypedSend').onclick = sendTyped;
  $('btnReveal').onclick = reveal;
  $('btnTake').onclick = askTake;
  $('btnExtend').onclick = extend;
  $('btnDone').onclick = finishSession;

  $('reaskSeg').onclick = e => { if (e.target.dataset.v) document.querySelectorAll('#reaskSeg button').forEach(b => b.classList.toggle('active', b === e.target)); };
  $('clearSeg').onclick = e => { if (e.target.dataset.v) document.querySelectorAll('#clearSeg button').forEach(b => b.classList.toggle('active', b === e.target)); };
  $('btnSaveField').onclick = saveField;
  $('btnDeleteEntry').onclick = async () => {
    if (!currentDetail || !confirm('Delete this entry?')) return;
    await DB.del(currentDetail.id); toast('Deleted'); renderHome();
  };

  $('btnShowKey').onclick = e => {
    const i = $('apiKeyInput'); const showing = i.type === 'password';
    i.type = showing ? 'text' : 'password'; e.currentTarget.setAttribute('aria-pressed', String(showing));
  };
  $('btnForgetKey').onclick = () => {
    if (!confirm('Remove the API key from this device?')) return;
    settings.apiKey = ''; Settings.forgetKey(); $('apiKeyInput').value = ''; toast('API key removed');
  };
  $('langSeg').onclick = e => {
    if (!e.target.dataset.lang) return;
    settings.lang = e.target.dataset.lang;
    document.querySelectorAll('#langSeg button').forEach(b => b.classList.toggle('active', b.dataset.lang === settings.lang));
  };
  $('btnLoadModels').onclick = async e => {
    settings.apiKey = $('apiKeyInput').value.trim();
    if (!settings.apiKey) { toast('Enter your API key first'); return; }
    e.target.disabled = true;
    try {
      const models = await fetchModels();
      const chosen = settings.modelPicked ? settings.model : pickDefaultModel(models);
      fillModelSelect(models, chosen);
      toast(settings.modelPicked ? 'Model list loaded' : `Model list loaded — suggested: ${chosen}`, 4000);
    } catch (err) { toast(err.message, 5000); }
    finally { e.target.disabled = false; }
  };
  $('btnSaveSettings').onclick = async () => {
    settings.apiKey = $('apiKeyInput').value.trim();
    settings.rememberKey = $('rememberKey').checked;
    const picked = $('modelSel').value || settings.model;
    if (!settings.modelPicked && settings.apiKey && picked === DEFAULT_MODEL) {
      try { settings.model = pickDefaultModel(await fetchModels()); } catch { settings.model = picked; }
    } else settings.model = picked;
    settings.modelPicked = !!settings.apiKey;
    settings.ctx = $('ctxInput').value.trim();
    Settings.save(settings);
    toast(`Settings saved · ${settings.model}`, 3500);
    renderHome();
  };
  $('btnBackup').onclick = backupAll;
  $('btnRestore').onclick = () => $('restoreInput').click();
  $('restoreInput').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await restoreFromFile(f); };

  ['sitInput', 'listenerInput', 'wantInput', 'typedInput', 'takeInput', 'ctxInput', 'fieldNote'].forEach(id => attachTools(id));
  ['modelLine', 'takeLine'].forEach(id => attachTools(id, { clear: false }));
  window.addEventListener('beforeunload', e => { if (round && round.attempts?.length && !round.recall) { e.preventDefault(); e.returnValue = ''; } });
}

/* ---------- Init ---------- */
(async function init() {
  await DB.open();
  bind();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!settings.apiKey) renderSettings(); else renderHome();
})();
