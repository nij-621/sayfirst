/* SayFirst — daily "point first" drill. Text goes to the Claude API only when you grade; rounds are stored in this device's IndexedDB */
'use strict';

const API = 'https://api.anthropic.com/v1/messages';
const $ = id => document.getElementById(id);
const LOCALE = 'en-GB';
const DEFAULT_MODEL = 'claude-opus-5';

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
let settings = Object.assign({ apiKey: '', model: DEFAULT_MODEL, lang: 'en', rememberKey: true, ctx: '', src: 'generated' }, Settings.load());

/* ---------- Storage (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sayfirst', 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore('rounds', { keyPath: 'id' });
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

/* ---------- Claude API ---------- */
async function apiError(r) {
  let msg = `HTTP ${r.status}`;
  try { msg = (await r.json()).error?.message || msg; } catch {}
  if (r.status === 401) msg = 'Invalid API key. Check it in Settings.';
  if (r.status === 429) msg = 'Rate limit reached. Try again in a moment.';
  if (r.status === 529) msg = 'Claude is overloaded right now. Try again shortly.';
  return new Error(msg);
}

// One structured-output call. Returns the parsed JSON object.
async function askJSON(system, user, schema, maxTokens = 8192) {
  const body = {
    model: settings.model,
    max_tokens: maxTokens,
    system,
    // effort is not accepted on Haiku 4.5
    output_config: settings.model.includes('haiku') ? { format: { type: 'json_schema', schema } } : { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  };
  const r = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await apiError(r);
  const data = await r.json();
  if (data.stop_reason === 'refusal') throw new Error('The model declined this request. Try rephrasing the situation.');
  if (data.stop_reason === 'max_tokens') throw new Error('Response was cut off. Try again.');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text); } catch { throw new Error('Could not read the response. Try again.'); }
}

/* ---------- Prompts ---------- */
const MODES = {
  oneliner: {
    label: 'One-liner',
    answerTitle: 'Your opening line',
    hint: 'One or two sentences, as you would say them out loud. Lead with the question or the ask. Aim for under 30 seconds.',
    shape: 'ONE or TWO spoken sentences: (1) the question or ask, stated first; (2) at most one sentence of context that tells the listener why they are hearing this. Nothing else.',
    frame: 'The user is about to walk over to a colleague or team lead (or ping them) about a work situation. Their habit is to start with a chronological story ("So there was this email from X, and they said...") and never state what they actually want. The drill: put the question or ask in the first sentence.',
  },
  pitch: {
    label: '3-sentence pitch',
    answerTitle: 'Your three sentences',
    hint: 'Exactly three sentences you could say with the screen off: (1) who has what problem, (2) what this does about it, (3) what you want from the people in the room.',
    shape: 'EXACTLY THREE spoken sentences: (1) who has what problem today, (2) what this thing does about it — the value, not the clicks, (3) what you want from the audience (decision, feedback, adoption, time).',
    frame: 'The user is about to demo or present something they built (an internal app, a process, a tool) at work. Their habit is to start narrating the screen ("so here you click...") without ever saying what problem it solves, so a colleague ends up summarising the value for them. The drill: three sentences that frame the demo before any screen is shown.',
  },
};

const CRITERIA = [
  { key: 'point_first', en: 'Point first', ko: '결론 먼저' },
  { key: 'framing', en: 'Framing', ko: '프레이밍' },
  { key: 'references', en: 'Clear references', ko: '지시어 명확' },
  { key: 'sentences', en: 'Clean sentences', ko: '문장 계획' },
];

const SCENARIO_SCHEMA = {
  type: 'object',
  properties: {
    scenario: { type: 'string', description: 'The situation, 2–4 sentences, second person, concrete names/numbers/dates.' },
    audience: { type: 'string', description: 'Who the user is about to talk to and what that person cares about, one sentence.' },
  },
  required: ['scenario', 'audience'],
  additionalProperties: false,
};

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['point_first', 'framing', 'references', 'sentences'] },
          score: { type: 'integer', enum: [0, 1, 2] },
          note: { type: 'string', description: 'One or two sentences. Quote the user\'s own words. Say what to change, not just what is wrong.' },
        },
        required: ['key', 'score', 'note'],
        additionalProperties: false,
      },
    },
    model_line: { type: 'string', description: 'A rewrite of the user\'s answer with the same content that would score 8/8. Natural spoken English, first person. Respect the sentence count for the mode.' },
    why: { type: 'string', description: 'One sentence: the single biggest structural change between the user\'s version and the model line.' },
  },
  required: ['criteria', 'model_line', 'why'],
  additionalProperties: false,
};

function langName(l) { return l === 'ko' ? 'Korean (한국어)' : 'English'; }

function scenarioPrompt(mode, recent) {
  const m = MODES[mode];
  return {
    system: `You write short, realistic workplace scenarios for a speaking drill. ${m.frame}
${settings.ctx ? `\nAbout the user's work (use it to make scenarios feel like theirs — real-sounding names, systems, numbers): ${settings.ctx}` : ''}
Rules: second person ("You just noticed…"). Concrete: a name, a number, a date, a system. Slightly messy — there is a real judgment call inside, so a good answer needs an actual question or ask, not a status report. English only. No preamble.`,
    user: `Write one new scenario for the "${m.label}" drill.${recent.length ? `\nDo not reuse these recent themes:\n- ${recent.join('\n- ')}` : ''}`,
  };
}

function gradePrompt(mode, scenario, audience, answer, isRewrite, previous) {
  const m = MODES[mode];
  return {
    system: `You are a blunt, precise speaking coach for a non-native English speaker in an Operations role. Their diagnosed pattern (from real meeting transcripts): the conclusion arrives after 30–40 seconds of narrative; no framing before details; vague pointers ("this", "it", "all those stuff"); sentences started and then rebuilt mid-way. Colleagues have to re-summarise what they meant.

Grade the answer for the "${m.label}" drill. Expected shape: ${m.shape}

Score each criterion 0–2 (2 = fully there, 1 = partly, 0 = missing):
- point_first: is the question / ask / conclusion in the FIRST sentence, before any story?
- framing: does the listener know why they're hearing this and what kind of input is wanted, without needing to ask "so what do you need from me?"
- references: every "this / it / that / the thing" has an explicit referent nearby; names and nouns, not pointers.
- sentences: each sentence is one planned thought — no restarts, no run-ons chaining three ideas with "and… so… but".

Be strict — a 2 means a native colleague would need zero clarifying questions. Notes must quote the user's words and say what to change. Ignore minor grammar unless it hides the meaning; this is about structure. Also penalise answers that ignore the expected shape (e.g. five sentences for the one-liner, or a screen walkthrough for the pitch).

Everyone in the user's workplace is a non-native English speaker (English is the shared language, nobody's mother tongue). So the model_line must use plain, common words and short sentences — roughly 15 words per sentence, no idioms, no clever phrasing. If it sounds like a native-speaker's polished line, it is wrong. Also give a 0 or 1 on "sentences" when the user's sentence would be hard for a non-native listener to follow.

model_line and any quoted English stay in English. Write the notes and "why" in ${langName(settings.lang)}. Output JSON only.`,
    user: `Scenario: ${scenario}
Listener: ${audience || 'not specified'}
${isRewrite ? `The user's first attempt (already graded, scores ${previous}): ${isRewrite}\n\nTheir REWRITE to grade now:` : 'Answer to grade:'}
${answer}`,
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
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtDate(ts) { return new Date(ts).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }); }
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function total(grade) { return grade ? grade.criteria.reduce((a, c) => a + c.score, 0) : null; }
function critName(key) { const c = CRITERIA.find(x => x.key === key); return c ? (settings.lang === 'ko' ? c.ko : c.en) : key; }

const views = ['home', 'practice', 'detail', 'settings'];
function show(view) {
  views.forEach(v => $(`view-${v}`).hidden = v !== view);
  window.scrollTo(0, 0);
}

/* ---------- Streak / home ---------- */
function computeStreak(rounds) {
  const days = new Set(rounds.map(r => dayKey(r.createdAt)));
  let streak = 0;
  const d = new Date();
  // A streak is alive if there is a round today or yesterday
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

async function renderHome() {
  const rounds = (await DB.all()).sort((a, b) => b.createdAt - a.createdAt);
  const streak = computeStreak(rounds);
  const today = rounds.filter(r => dayKey(r.createdAt) === dayKey(Date.now()));
  $('streakBadge').innerHTML = streak ? `<b>${streak}</b> day${streak === 1 ? '' : 's'}` : '';
  $('heroKicker').textContent = new Date().toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
  $('heroTitle').textContent = today.length ? 'Again. Point first.' : 'Say the point first.';
  $('heroSub').textContent = today.length
    ? `${today.length} round${today.length === 1 ? '' : 's'} today${streak > 1 ? ` · ${streak}-day streak` : ''}. One more won't hurt.`
    : (streak ? `${streak}-day streak on the line. Three minutes.` : 'One scenario, one line, one rewrite. About three minutes.');

  document.querySelectorAll('#srcSeg button').forEach(b => b.classList.toggle('active', b.dataset.src === settings.src));

  const list = $('historyList');
  list.innerHTML = '';
  $('emptyHistory').hidden = rounds.length > 0;
  rounds.slice(0, 40).forEach((r, i) => {
    const btn = document.createElement('button');
    btn.className = 'hist-item';
    btn.style.setProperty('--i', Math.min(i, 8));
    const t1 = total(r.grade), t2 = total(r.grade2);
    btn.innerHTML = `<span class="h-title">${esc(r.scenario)}</span>
      <span class="h-score">${t2 != null ? `${t1}→${t2}` : t1}<small>/8</small></span>
      <span class="h-meta">${fmtDate(r.createdAt)} · ${MODES[r.mode].label}${r.src === 'real' ? ' · real' : ''}</span>`;
    btn.onclick = () => openDetail(r.id);
    list.appendChild(btn);
  });
  show('home');
}

/* ---------- Practice ---------- */
let round = null;   // current in-progress round
let timerId = null, timerStart = 0;

function startTimer() {
  stopTimer();
  timerStart = Date.now();
  const el = $('timer');
  const tick = () => {
    const s = Math.floor((Date.now() - timerStart) / 1000);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('over', s >= 60);
  };
  tick();
  timerId = setInterval(tick, 1000);
}
function stopTimer() { clearInterval(timerId); timerId = null; }

async function startRound(mode) {
  if (!settings.apiKey) { toast('Add your API key in Settings first'); renderSettings(); return; }
  round = { id: crypto.randomUUID(), createdAt: Date.now(), mode, src: settings.src, scenario: '', audience: '', answer: '', grade: null, rewrite: '', grade2: null };
  const m = MODES[mode];
  $('modePill').textContent = m.label;
  $('srcPill').textContent = settings.src === 'real' ? 'real situation' : 'generated';
  $('answerTitle').textContent = m.answerTitle;
  $('answerHint').textContent = m.hint;
  $('answerInput').value = ''; $('answerInput').readOnly = false; $('btnGrade').hidden = false;
  $('rewriteInput').value = '';
  $('feedbackBox').hidden = true;
  $('regradeBox').hidden = true;
  $('answerBox').hidden = true;
  $('scenarioBox').hidden = true;
  $('realBox').hidden = settings.src !== 'real';
  $('btnRegen').hidden = settings.src === 'real';
  show('practice');
  if (settings.src === 'real') { $('realInput').value = ''; $('audienceInput').value = ''; $('realInput').focus(); }
  else await generateScenario();
}

async function generateScenario() {
  const box = $('scenarioBox');
  box.hidden = false; box.classList.add('loading');
  $('scenarioText').textContent = 'Writing a scenario…';
  $('scenarioAudience').textContent = '';
  $('answerBox').hidden = true;
  try {
    const recent = (await DB.all()).sort((a, b) => b.createdAt - a.createdAt).filter(r => r.mode === round.mode).slice(0, 8).map(r => r.scenario.slice(0, 120));
    const p = scenarioPrompt(round.mode, recent);
    const s = await askJSON(p.system, p.user, SCENARIO_SCHEMA, 2048);
    round.scenario = s.scenario; round.audience = s.audience;
    $('scenarioText').textContent = s.scenario;
    $('scenarioAudience').textContent = s.audience;
    box.classList.remove('loading');
    $('answerBox').hidden = false;
    startTimer();
    $('answerInput').focus();
  } catch (e) {
    box.classList.remove('loading');
    $('scenarioText').textContent = 'Could not get a scenario. ' + e.message;
    toast(e.message, 5000);
  }
}

function useReal() {
  const text = $('realInput').value.trim();
  if (!text) { toast('Describe the situation first'); return; }
  round.scenario = text;
  round.audience = $('audienceInput').value.trim();
  $('realBox').hidden = true;
  $('scenarioBox').hidden = false;
  $('scenarioText').textContent = text;
  $('scenarioAudience').textContent = round.audience ? `Listener: ${round.audience}` : '';
  $('answerBox').hidden = false;
  startTimer();
  $('answerInput').focus();
}

function renderCriteria(el, grade) {
  el.innerHTML = grade.criteria.map(c => `<div class="crit">
    <span class="crit-mark s${c.score}">${c.score}</span>
    <div><strong>${esc(critName(c.key))}</strong><p>${esc(c.note)}</p></div>
  </div>`).join('');
}

async function grade(isRewrite) {
  const input = isRewrite ? $('rewriteInput') : $('answerInput');
  const btn = isRewrite ? $('btnRegrade') : $('btnGrade');
  const answer = input.value.trim();
  if (!answer) { toast('Write something first'); return; }
  if (btn.disabled) return;
  btn.disabled = true; const old = btn.textContent; swapLabel(btn, 'Grading…');
  try {
    const p = gradePrompt(round.mode, round.scenario, round.audience, answer, isRewrite ? round.answer : null, isRewrite ? `${total(round.grade)}/8` : null);
    const g = await askJSON(p.system, p.user, GRADE_SCHEMA);
    if (isRewrite) {
      round.rewrite = answer; round.grade2 = g;
      $('scoreTotal2').innerHTML = `${total(g)}<small>/8</small>`;
      renderCriteria($('criteria2'), g);
      const d = total(g) - total(round.grade);
      const el = $('delta');
      el.textContent = d > 0 ? `+${d} — that's the shape.` : d === 0 ? 'Same score. Read the model line once more and go again tomorrow.' : `${d} — the rewrite drifted. Compare with the model line.`;
      el.className = 'delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
      $('regradeBox').hidden = false;
      $('regradeBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      stopTimer();
      round.answer = answer; round.grade = g;
      $('scoreTotal').innerHTML = `${total(g)}<small>/8</small>`;
      renderCriteria($('criteria'), g);
      $('modelLine').textContent = g.model_line;
      $('modelWhy').textContent = g.why;
      $('rewriteInput').value = answer;
      $('feedbackBox').hidden = false;
      $('answerInput').readOnly = true;
      $('btnGrade').hidden = true;
      $('feedbackBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (e) {
    toast(e.message, 5000);
  } finally {
    btn.disabled = false; swapLabel(btn, old);
  }
}

async function finishRound(next) {
  if (!round || !round.grade) { renderHome(); return; }
  await DB.put(round);
  const mode = round.mode;
  round = null;
  if (next) startRound(mode);
  else { toast('Saved. See you tomorrow.'); renderHome(); }
}

/* ---------- Detail ---------- */
let currentDetail = null;
async function openDetail(id) {
  const r = await DB.get(id);
  if (!r) return renderHome();
  currentDetail = r;
  const crit = g => g.criteria.map(c => `<div class="crit"><span class="crit-mark s${c.score}">${c.score}</span><div><strong>${esc(critName(c.key))}</strong><p>${esc(c.note)}</p></div></div>`).join('');
  $('detailBody').innerHTML = `
    <div class="practice-head"><span class="pill">${MODES[r.mode].label}</span><span class="pill pill-soft">${r.src === 'real' ? 'real situation' : 'generated'}</span></div>
    <p class="detail-meta">${new Date(r.createdAt).toLocaleString(LOCALE)}</p>
    <div class="card"><h3>Scenario</h3><p class="detail-q">${esc(r.scenario)}</p>${r.audience ? `<p class="hint">${esc(r.audience)}</p>` : ''}</div>
    <div class="card"><div class="card-head"><h3>First attempt</h3><span class="score">${total(r.grade)}<small>/8</small></span></div>
      <div class="detail-answer">${esc(r.answer)}</div><div class="criteria">${crit(r.grade)}</div></div>
    <div class="card"><h3>Model line</h3><blockquote class="model-line">${esc(r.grade.model_line)}</blockquote><p class="hint">${esc(r.grade.why)}</p></div>
    ${r.grade2 ? `<div class="card"><div class="card-head"><h3>Rewrite</h3><span class="score">${total(r.grade2)}<small>/8</small></span></div>
      <div class="detail-answer">${esc(r.rewrite)}</div><div class="criteria">${crit(r.grade2)}</div></div>` : ''}`;
  show('detail');
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
  const payload = { app: 'SayFirst', version: 1, exportedAt: new Date().toISOString(), rounds };
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
  for (const r of list) { if (r?.id && r.grade) { await DB.put(r); n++; } }
  toast(`Restored ${n} round${n === 1 ? '' : 's'}`);
  renderHome();
}

/* ---------- Settings ---------- */
function renderSettings() {
  $('apiKeyInput').value = settings.apiKey;
  $('rememberKey').checked = settings.rememberKey !== false;
  $('modelSel').value = settings.model;
  if ($('modelSel').value !== settings.model) $('modelSel').value = DEFAULT_MODEL;
  $('ctxInput').value = settings.ctx || '';
  document.querySelectorAll('#langSeg button').forEach(b => b.classList.toggle('active', b.dataset.lang === settings.lang));
  show('settings');
}

/* ---------- Bind ---------- */
function bind() {
  $('btnHome').onclick = () => { if (round?.grade && !confirm('Leave without saving this round?')) return; round = null; stopTimer(); renderHome(); };
  $('btnSettings').onclick = renderSettings;
  document.querySelectorAll('.mode-card').forEach(b => b.onclick = () => startRound(b.dataset.mode));
  $('srcSeg').onclick = e => {
    if (!e.target.dataset.src) return;
    settings.src = e.target.dataset.src; Settings.save(settings);
    document.querySelectorAll('#srcSeg button').forEach(b => b.classList.toggle('active', b.dataset.src === settings.src));
  };
  $('btnUseReal').onclick = useReal;
  $('btnRegen').onclick = generateScenario;
  $('btnGrade').onclick = () => grade(false);
  $('btnRegrade').onclick = () => grade(true);
  $('btnDone').onclick = () => finishRound(false);
  $('btnAnother').onclick = () => finishRound(true);
  $('btnDeleteEntry').onclick = async () => {
    if (!currentDetail || !confirm('Delete this entry?')) return;
    await DB.del(currentDetail.id); toast('Deleted'); renderHome();
  };

  $('btnShowKey').onclick = e => {
    const i = $('apiKeyInput');
    const showing = i.type === 'password';
    i.type = showing ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(showing));
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
  $('btnSaveSettings').onclick = () => {
    settings.apiKey = $('apiKeyInput').value.trim();
    settings.rememberKey = $('rememberKey').checked;
    settings.model = $('modelSel').value;
    settings.ctx = $('ctxInput').value.trim();
    Settings.save(settings);
    toast('Settings saved');
    renderHome();
  };
  $('btnBackup').onclick = backupAll;
  $('btnRestore').onclick = () => $('restoreInput').click();
  $('restoreInput').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await restoreFromFile(f); };
  window.addEventListener('beforeunload', e => { if (round?.grade) { e.preventDefault(); e.returnValue = ''; } });
}

/* ---------- Init ---------- */
(async function init() {
  await DB.open();
  bind();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!settings.apiKey) renderSettings(); else renderHome();
})();
