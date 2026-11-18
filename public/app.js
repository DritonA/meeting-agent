import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS = {
  starting: ['Starting', 'busy'],
  joining: ['Joining', 'busy'],
  waiting_admission: ['Waiting to be admitted', 'busy'],
  in_meeting: ['Live', 'live'],
  leaving: ['Leaving', 'busy'],
  processing: ['Writing notes', 'busy'],
  done: ['Finished', 'ok'],
  failed: ['Failed', 'bad'],
  cancelled: ['Cancelled', ''],
  interrupted: ['Interrupted', 'bad'],
};
const ACTIVE = new Set(['starting', 'joining', 'waiting_admission', 'in_meeting', 'leaving', 'processing']);
const FILE_LABELS = {
  'notes.md': 'Notes (.md)',
  'transcript.md': 'Transcript (.md)',
  'transcript.txt': 'Transcript (.txt)',
  'transcript.json': 'Transcript (.json)',
  'audio.webm': 'Audio recording',
  'audio-transcript.json': 'Audio transcript (.json)',
  'audio-transcript.md': 'Audio transcript (.md)',
  'error.png': 'Error screenshot',
  'log.txt': 'Log',
};

const fileLabel = (f) =>
  FILE_LABELS[f] ||
  (/^audio-(\d+)\.webm$/.test(f) ? `Audio recording (part ${f.match(/\d+/)[0]})` : null) ||
  (/^captions-debug-\d\.json$/.test(f) ? `Caption diagnostics ${f.match(/\d/)[0]}` : null);
const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};
const hasIssues = (m) => (m.warnings || []).length > 0;

const state = {
  config: null,
  meetings: [],
  selected: null,
  view: null, // { meta, segments: Map, notes, audioTranscript, log: [] }
  es: null,
  tab: 'transcript',
  search: '',
};

// ---------- formatting ----------
const pad = (n) => String(n).padStart(2, '0');
function offset(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}
function duration(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#00838f', '#c2185b', '#5f6368', '#3949ab', '#6d4c41'];
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json', 'X-Meeting-Agent': '1' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---------- sidebar ----------
async function loadMeetings() {
  try {
    state.meetings = await api('/api/meetings');
    renderList();
  } catch { /* server restarting */ }
}

function renderList() {
  const ul = $('#meetingList');
  if (!state.meetings.length) {
    ul.innerHTML = '<li class="placeholder" style="cursor:default">No meetings yet.</li>';
    return;
  }
  ul.innerHTML = state.meetings
    .map((m) => {
      let [label, cls] = STATUS[m.status] || [m.status, ''];
      if (m.status === 'done' && hasIssues(m)) [label, cls] = ['Finished with issues', 'bad'];
      else if (m.status === 'in_meeting' && (m.warnings || []).some((w) => !w.resolvedAt)) label = 'Live, with issues';
      return `<li data-id="${esc(m.id)}" class="${m.id === state.selected ? 'selected' : ''}">
        <div class="t">${esc(m.title)}</div>
        <div class="s"><span class="pill ${cls}">${esc(label)}</span>${esc(new Date(m.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</div>
      </li>`;
    })
    .join('');
}

$('#meetingList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) select(li.dataset.id);
});

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#joinBtn');
  const err = $('#joinError');
  err.hidden = true;
  btn.disabled = true;
  try {
    const m = await api('/api/meetings', {
      method: 'POST',
      body: JSON.stringify({ url: $('#url').value, title: $('#title').value, botName: $('#botName').value }),
    });
    $('#url').value = '';
    $('#title').value = '';
    await loadMeetings();
    select(m.id);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- detail ----------
function select(id) {
  state.selected = id;
  state.es?.close();
  state.view = null;
  renderList();
  const detail = $('#detail');
  detail.innerHTML = '';
  detail.append($('#detailTpl').content.cloneNode(true));
  wireDetail(detail);
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);

  const es = new EventSource(`/api/meetings/${encodeURIComponent(id)}/events`);
  state.es = es;
  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    state.view = {
      meta: snap.meta,
      segments: new Map(snap.segments.map((s) => [s.id, s])),
      notes: snap.notes,
      audioTranscript: snap.audioTranscript,
      log: [],
    };
    renderAll();
  });
  es.addEventListener('meta', (e) => {
    if (!state.view) return;
    state.view.meta = JSON.parse(e.data);
    renderHead();
    loadMeetings();
  });
  es.addEventListener('segment', (e) => {
    if (!state.view) return;
    const seg = JSON.parse(e.data);
    state.view.segments.set(seg.id, seg);
    scheduleTranscript();
  });
  es.addEventListener('notes', (e) => {
    if (!state.view) return;
    state.view.notes = JSON.parse(e.data);
    renderMarkdown('notes');
    renderHead();
  });
  es.addEventListener('audio-transcript', (e) => {
    if (!state.view) return;
    state.view.audioTranscript = JSON.parse(e.data);
    renderMarkdown('audio');
    renderHead();
  });
  es.addEventListener('log', (e) => {
    if (!state.view) return;
    state.view.log.push(JSON.parse(e.data));
    renderLog();
  });
}

function wireDetail(root) {
  root.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      showTab();
    }),
  );
  $('.stop', root).addEventListener('click', async (e) => {
    e.target.disabled = true;
    await api(`/api/meetings/${encodeURIComponent(state.selected)}/stop`, { method: 'POST' }).catch((ex) => alert(ex.message));
  });
  $('.regen', root).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/api/meetings/${encodeURIComponent(state.selected)}/notes`, { method: 'POST' });
      state.tab = 'notes';
      showTab();
    } catch (ex) {
      alert(ex.message);
      e.target.disabled = false;
    }
  });
  $('.stt-run', root).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/api/meetings/${encodeURIComponent(state.selected)}/audio-transcript`, {
        method: 'POST',
        body: JSON.stringify({ provider: $('.stt-provider').value }),
      });
      state.tab = 'log';
      showTab();
    } catch (ex) {
      alert(ex.message);
      e.target.disabled = false;
    }
  });
  const providers = state.config?.transcriptionProviders || [];
  $('.stt-provider', root).innerHTML = providers
    .map((p) => `<option value="${esc(p.id)}" ${p.id === state.config.defaultTranscriptionProvider ? 'selected' : ''}>${esc(p.label)}</option>`)
    .join('');
  $('.search', root).addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderTranscript();
  });
}

function showTab() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  document.querySelectorAll('.tab-body').forEach((s) => (s.hidden = s.dataset.body !== state.tab));
}

function renderAll() {
  renderHead();
  renderTranscript();
  renderMarkdown('notes');
  renderMarkdown('audio');
  renderLog();
  showTab();
}

function renderHead() {
  const v = state.view;
  if (!v) return;
  const m = v.meta;
  let [label, cls] = STATUS[m.status] || [m.status, ''];
  if (m.status === 'done' && hasIssues(m)) [label, cls] = ['Finished with issues', 'bad'];
  $('.m-title').textContent = m.title;
  const pill = $('.pill', $('.detail-head'));
  pill.className = `pill ${cls}`;
  pill.textContent = label;
  $('.status-detail').textContent = m.error && m.status === 'failed' ? m.error : m.statusDetail || '';

  // Capture problems are always shown, live and afterwards, so a broken capture can't look fine.
  const warnings = m.warnings || [];
  const wBox = $('.warnings');
  wBox.hidden = !warnings.length;
  if (warnings.length) {
    const t0 = m.joinedAt || warnings[0].at;
    const open = warnings.filter((w) => !w.resolvedAt).length;
    wBox.innerHTML = `<h3>${open && ACTIVE.has(m.status) ? 'Capture problem right now' : 'Parts of this meeting may be missing'}</h3><ul>${warnings
      .map(
        (w) => `<li class="${w.resolvedAt ? 'resolved' : ''}">${esc(w.message)} <span class="when">at ${offset(w.at - t0)}${
          w.resolvedAt ? `, fixed after ${duration(Math.max(60_000, w.resolvedAt - w.at))}` : w.untilEnd ? ', until the meeting ended' : ''
        }</span></li>`,
      )
      .join('')}</ul>`;
  }

  const busy = Boolean(m.busy);
  $('.stop').hidden = !['starting', 'joining', 'waiting_admission', 'in_meeting'].includes(m.status);
  const regen = $('.regen');
  regen.hidden = ACTIVE.has(m.status) || (!m.segmentCount && m.audioTranscriptStatus !== 'done');
  regen.disabled = busy || m.notesStatus === 'generating';
  regen.textContent = m.notesStatus === 'generating' ? 'Writing notes' : m.notesStatus === 'done' ? 'Regenerate notes' : 'Generate notes';

  const providers = state.config?.transcriptionProviders || [];
  const hasAudio = (m.files || []).some((f) => /^audio(-\d+)?\.webm$/.test(f));
  $('.stt').hidden = ACTIVE.has(m.status) || !hasAudio || !providers.length;
  $('.stt-run').disabled = busy || m.audioTranscriptStatus === 'running';
  $('.stt-run').textContent = m.audioTranscriptStatus === 'running' ? 'Transcribing' : m.audioTranscriptStatus === 'done' ? 'Transcribe audio again' : 'Transcribe audio';

  const facts = [];
  if (m.joinedAt) facts.push(`<span>Joined <b>${esc(new Date(m.joinedAt).toLocaleString())}</b></span>`);
  if (m.joinedAt) facts.push(`<span>Duration <b class="dur">${duration((m.endedAt || Date.now()) - m.joinedAt)}</b></span>`);
  if (m.speakers?.length) facts.push(`<span>Speakers <b>${esc(m.speakers.join(', '))}</b></span>`);
  if (m.status === 'in_meeting') {
    const h = m.health || {};
    if (m.participantCount) facts.push(`<span>In call <b>${m.participantCount}</b></span>`);
    facts.push(h.captionsOn === false ? '<span class="bad">Captions off</span>' : `<span>Last caption <b>${h.lastCaptionAt ? ago(h.lastCaptionAt) : 'none yet'}</b></span>`);
    if (state.config?.recordAudio) {
      facts.push(
        h.recording === false
          ? '<span class="bad">Not recording</span>'
          : `<span>Recording <b>${h.audioStreams ?? 0} audio stream(s)</b>${h.lastSoundAt ? `, sound ${ago(h.lastSoundAt)}` : ''}</span>`,
      );
    }
  }
  facts.push(`<span>Link <b>${esc(m.url)}</b></span>`);
  if (m.notesError && m.notesStatus !== 'generating') facts.push(`<span style="color:var(--warn)">${esc(m.notesError)}</span>`);
  if (m.audioTranscriptError && m.audioTranscriptStatus !== 'running') facts.push(`<span style="color:var(--warn)">${esc(m.audioTranscriptError)}</span>`);
  $('.facts').innerHTML = facts.join('');

  $('.downloads').innerHTML = (m.files || [])
    .filter((f) => fileLabel(f))
    .map((f) => `<a href="/api/meetings/${encodeURIComponent(m.id)}/files/${encodeURIComponent(f)}?download=1">${esc(fileLabel(f))}</a>`)
    .join('');

  $('.tabs [data-tab="audio"]').hidden = !v.audioTranscript;
}

let transcriptQueued = false;
function scheduleTranscript() {
  if (transcriptQueued) return;
  transcriptQueued = true;
  setTimeout(() => {
    transcriptQueued = false;
    renderTranscript();
  }, 150);
}

function turnsOf(segments) {
  const sorted = [...segments.values()].filter((s) => s.text).sort((a, b) => a.start - b.start);
  const turns = [];
  for (const s of sorted) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < 30000) {
      last.parts.push(s);
      last.end = Math.max(last.end, s.end);
    } else {
      turns.push({ speaker: s.speaker, start: s.start, end: s.end, parts: [s] });
    }
  }
  return turns;
}

function highlight(text) {
  const safe = esc(text);
  if (!state.search) return safe;
  const q = esc(state.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(q, 'gi'), (m) => `<mark>${m}</mark>`);
}

function renderTranscript() {
  const v = state.view;
  const box = $('.transcript');
  if (!v || !box) return;
  const origin = v.meta.joinedAt || [...v.segments.values()][0]?.start || 0;
  let turns = turnsOf(v.segments);
  if (state.search) {
    turns = turns.filter(
      (t) => t.speaker.toLowerCase().includes(state.search) || t.parts.some((p) => p.text.toLowerCase().includes(state.search)),
    );
  }
  if (!turns.length) {
    const live = v.meta.status === 'in_meeting';
    box.innerHTML = `<div class="placeholder">${
      state.search ? 'No matches.' : live ? 'Listening… captions appear here as people speak.' : 'No transcript for this meeting.'
    }</div>`;
    return;
  }
  const scroller = $('#detail');
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  box.innerHTML = turns
    .map(
      (t) => `<div class="turn">
        <div class="avatar" style="background:${colorFor(t.speaker)}">${esc(initials(t.speaker))}</div>
        <div>
          <div><span class="who">${esc(t.speaker)}</span><span class="when">${offset(t.start - origin)}</span></div>
          <div class="text">${t.parts.map((p) => (p.final ? highlight(p.text) : `<span class="pending">${highlight(p.text)}</span>`)).join(' ')}</div>
        </div>
      </div>`,
    )
    .join('');
  const follow = $('.autoscroll input')?.checked;
  if (follow && v.meta.status === 'in_meeting' && nearBottom && !state.search) scroller.scrollTop = scroller.scrollHeight;
}

function renderMarkdown(which) {
  const v = state.view;
  const el = document.querySelector(`.tab-body[data-body="${which}"]`);
  if (!v || !el) return;
  const md = which === 'notes' ? v.notes : v.audioTranscript;
  if (md) {
    // Notes contain text from meeting participants (names, titles, speech): never trust it as HTML.
    el.innerHTML = DOMPurify.sanitize(marked.parse(md), { USE_PROFILES: { html: true } });
  } else if (which === 'notes') {
    const s = v.meta.status;
    el.innerHTML = `<p class="placeholder">${
      ACTIVE.has(s) ? 'Notes are written automatically when the meeting ends.' : esc(v.meta.notesError || 'No notes for this meeting.')
    }</p>`;
  }
}

function renderLog() {
  const v = state.view;
  const ol = $('.log');
  if (!v || !ol) return;
  ol.innerHTML = v.log.length
    ? v.log.map((l) => `<li>${new Date(l.ts).toLocaleTimeString()} <span>${esc(l.msg)}</span></li>`).join('')
    : '<li>Live activity for this meeting shows here while the page is open. The full log is in log.txt.</li>';
}

// Tick the live duration.
setInterval(() => {
  const m = state.view?.meta;
  const el = $('.dur');
  if (m?.joinedAt && !m.endedAt && el) el.textContent = duration(Date.now() - m.joinedAt);
}, 15000);

// ---------- boot ----------
(async function init() {
  const cfg = await api('/api/config').catch(() => null);
  state.config = cfg;
  if (cfg) {
    $('#botName').placeholder = cfg.botName;
    if (!cfg.notesConfigured) $('#configNote').textContent = 'ANTHROPIC_API_KEY not set: transcripts work, AI notes are skipped.';
  }
  await loadMeetings();
  setInterval(loadMeetings, 5000);
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash && state.meetings.some((m) => m.id === fromHash)) select(fromHash);
  else if (state.meetings[0] && ACTIVE.has(state.meetings[0].status)) select(state.meetings[0].id);
})();
