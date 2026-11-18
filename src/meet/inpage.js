// Functions in this file are serialized and run inside the Google Meet page
// (via page.addInitScript / page.evaluate). They must be self-contained: no imports,
// no references to anything outside the function body.

/**
 * Init script (runs before Meet's own code). Wraps RTCPeerConnection so we can see every
 * incoming audio track, which the recorder mixes into one audio file.
 */
export function rtcHookInitScript() {
  if (window.__maRtcHooked) return;
  window.__maRtcHooked = true;
  const tracks = [];
  const listeners = new Set();
  window.__maOnAudioTrack = (fn) => {
    listeners.add(fn);
    tracks.forEach((t) => {
      try { fn(t); } catch (e) { /* ignore */ }
    });
  };
  const Orig = window.RTCPeerConnection;
  if (!Orig) return;
  class HookedRTCPeerConnection extends Orig {
    constructor(...args) {
      super(...args);
      this.addEventListener('track', (e) => {
        if (!e.track || e.track.kind !== 'audio') return;
        tracks.push(e.track);
        listeners.forEach((fn) => {
          try { fn(e.track); } catch (err) { /* ignore */ }
        });
      });
    }
  }
  window.RTCPeerConnection = HookedRTCPeerConnection;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = HookedRTCPeerConnection;
}

/**
 * Starts recording all remote audio into WebM/Opus. Chunks are sent to Node every 5 s
 * through window.__meetAgentAudio(recorderId, base64). Each recorder run gets its own id, so
 * a restart (e.g. after a page reload) goes to a new file instead of corrupting the old one.
 * Returns { id, startedAt }.
 */
export async function startAudioRecorder() {
  if (window.__maRecorder && window.__maRecorder.state !== 'inactive') {
    return { id: window.__maRecorderId, startedAt: window.__maRecorderStartedAt };
  }
  const ctx = new AudioContext({ sampleRate: 48000 });
  try { await ctx.resume(); } catch (e) { /* ignore */ }
  const dest = ctx.createMediaStreamDestination();
  const mix = ctx.createGain();
  mix.connect(dest);

  // A silent source keeps the timeline continuous even when nobody talks.
  const silent = ctx.createConstantSource();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  silent.connect(gain).connect(dest);
  silent.start();

  // Level meter: remembers when real sound last went into the recording.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  mix.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  window.__maLastSoundAt = null;
  clearInterval(window.__maLevelTimer);
  window.__maLevelTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / samples.length) > 0.003) window.__maLastSoundAt = Date.now();
  }, 500);

  const seen = new Set();
  const tracks = [];
  window.__maTrackCount = () => tracks.filter((t) => t.readyState === 'live').length;
  const sinks = [];
  const addTrack = (track) => {
    if (seen.has(track.id)) return;
    seen.add(track.id);
    tracks.push(track);
    const stream = new MediaStream([track]);
    // Chrome only feeds remote WebRTC audio into Web Audio if the stream is also attached
    // to a media element. A muted element is enough and makes no sound.
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    sinks.push(el);
    ctx.createMediaStreamSource(stream).connect(mix);
  };
  if (window.__maOnAudioTrack) window.__maOnAudioTrack(addTrack);

  // Fallback: also pick up audio from any <audio>/<video> elements Meet plays remote streams in.
  const scanMedia = () => {
    document.querySelectorAll('audio, video').forEach((m) => {
      const s = m.srcObject;
      if (s && typeof s.getAudioTracks === 'function' && !sinks.includes(m)) {
        s.getAudioTracks().forEach((t) => addTrack(t));
      }
    });
  };
  scanMedia();
  window.__maMediaScan = setInterval(scanMedia, 5000);

  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 64000 });
  let chain = Promise.resolve();
  const toBase64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  };
  const id = `r${Date.now()}`;
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const blob = e.data;
    chain = chain.then(async () => {
      try {
        await window.__meetAgentAudio(id, toBase64(await blob.arrayBuffer()));
        window.__maLastChunkAt = Date.now();
      } catch (err) { /* page closing */ }
    });
  };
  window.__maStopRecorder = () =>
    new Promise((resolve) => {
      clearInterval(window.__maMediaScan);
      clearInterval(window.__maLevelTimer);
      if (rec.state === 'inactive') return chain.then(resolve);
      rec.onstop = () => setTimeout(() => chain.then(resolve), 300);
      rec.stop();
    });
  rec.start(5000);
  window.__maRecorder = rec;
  window.__maRecorderId = id;
  window.__maRecorderStartedAt = Date.now();
  return { id, startedAt: window.__maRecorderStartedAt };
}

/** Recorder status for the health check, or null when no recorder is running in this page. */
export function recorderHealth() {
  const rec = window.__maRecorder;
  if (!rec) return null;
  return {
    id: window.__maRecorderId,
    state: rec.state,
    startedAt: window.__maRecorderStartedAt,
    tracks: window.__maTrackCount ? window.__maTrackCount() : 0,
    lastSoundAt: window.__maLastSoundAt || null,
    lastChunkAt: window.__maLastChunkAt || null,
  };
}

/**
 * Watches the captions panel and reports snapshots to Node through
 * window.__meetAgentCaption({ key, speaker, text, ts }) and ({ key, removed: true }).
 */
export function startCaptionObserver(SEL) {
  if (window.__maCaptionsStarted) return 'already-running';
  window.__maCaptionsStarted = true;

  const ids = new WeakMap();
  let seq = 0;
  const last = new Map();
  let present = new Set();
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const one = (root, list) => {
    for (const s of list) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
      } catch (e) { /* bad selector */ }
    }
    return null;
  };
  const all = (root, list) => {
    for (const s of list) {
      try {
        const els = root.querySelectorAll(s);
        if (els.length) return [...els];
      } catch (e) { /* bad selector */ }
    }
    return [];
  };
  const lines = (el) => (el.innerText || '').split('\n').map(clean).filter(Boolean);

  const findContainer = () => one(document, SEL.captionContainers);

  const findBlocks = (c) => {
    const known = all(c, SEL.captionBlocks);
    if (known.length) return known;
    // Structural fallback: each caption turn has an avatar image next to the speaker name.
    const blocks = new Set();
    c.querySelectorAll('img').forEach((img) => {
      let el = img.parentElement;
      while (el && el !== c && lines(el).length < 2) el = el.parentElement;
      if (el && el !== c) blocks.add(el);
    });
    if (blocks.size) return [...blocks];
    return [...c.children].filter((el) => lines(el).length > 0);
  };

  const parse = (b, prevSpeaker) => {
    const nameEl = one(b, SEL.speakerName);
    const textEls = all(b, SEL.captionText);
    let speaker = nameEl ? clean(nameEl.textContent) : '';
    let text = textEls.length ? clean(textEls.map((e) => e.textContent).join(' ')) : '';
    if (!speaker || !text) {
      const ls = lines(b);
      const hasAvatar = !!b.querySelector('img');
      if (ls.length >= 2 && (hasAvatar || ls[0].length <= 60)) {
        speaker = speaker || ls[0];
        text = text || ls.slice(1).join(' ');
      } else if (ls.length) {
        text = text || ls.join(' ');
      }
    }
    if (speaker.length > 80) {
      text = clean(`${speaker} ${text}`);
      speaker = '';
    }
    return { speaker: speaker || prevSpeaker || 'Unknown speaker', text };
  };

  const send = (payload) => {
    try {
      const p = window.__meetAgentCaption(payload);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* page closing */ }
  };

  const scan = () => {
    const c = findContainer();
    window.__maCaptionsVisible = !!c;
    const now = Date.now();
    const seen = new Set();
    if (c) {
      let prev = null;
      for (const b of findBlocks(c)) {
        let key = ids.get(b);
        if (!key) {
          key = `b${++seq}`;
          ids.set(b, key);
        }
        const p = parse(b, prev);
        if (!p.text) continue;
        prev = p.speaker;
        seen.add(key);
        const sig = `${p.speaker}\u0000${p.text}`;
        if (last.get(key) !== sig) {
          last.set(key, sig);
          send({ key, speaker: p.speaker, text: p.text, ts: now });
        }
      }
    }
    for (const k of present) {
      if (!seen.has(k)) {
        send({ key: k, removed: true, ts: now });
        last.delete(k);
      }
    }
    present = seen;
  };

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      try { scan(); } catch (e) { /* ignore */ }
    }, 200);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  window.__maCaptionInterval = setInterval(() => {
    try { scan(); } catch (e) { /* ignore */ }
  }, 1000);
  return 'started';
}

/** Best-effort participant snapshot: { count, names } from video tiles and the People panel. */
export function readParticipants(botName) {
  const ids = new Set();
  const names = new Set();
  // Skip icon names (Meet's icon font uses words like "frame_person", "mic_off").
  const ok = (n) =>
    n && n.length <= 60 && !/\n/.test(n) && !/^[a-z0-9]+(_[a-z0-9]+)+$/.test(n) &&
    !/^(you|presentation)$/i.test(n) && n !== botName;
  document.querySelectorAll('[data-participant-id]').forEach((tile) => {
    const id = tile.getAttribute('data-participant-id');
    if (id) ids.add(id);
    const el = tile.querySelector('[data-self-name]') || tile.querySelector('.notranslate');
    const n = el ? (el.getAttribute('data-self-name') ? '' : (el.textContent || '').trim()) : '';
    if (ok(n)) names.add(n);
  });
  document.querySelectorAll('[role="listitem"][aria-label]').forEach((li) => {
    const n = (li.getAttribute('aria-label') || '').trim();
    if (ok(n) && li.closest('[aria-label*="eople" i], [aria-label*="articipant" i]')) names.add(n);
  });
  return { count: ids.size, names: [...names] };
}

/** Whether captions are currently on (any of: caption panel present, "turn off" control, pressed CC toggle). */
export function captionsState(SEL) {
  const container = SEL.captionContainers.some((s) => {
    try { return !!document.querySelector(s); } catch (e) { return false; }
  });
  let offButton = false;
  let pressed = false;
  document.querySelectorAll('[aria-label]').forEach((el) => {
    const l = el.getAttribute('aria-label') || '';
    if (/turn off captions|hide captions|captions are on/i.test(l)) offButton = true;
    if (/caption/i.test(l) && el.getAttribute('aria-pressed') === 'true') pressed = true;
  });
  return { on: container || offButton || pressed, container, offButton, pressed };
}

/** Snapshot of the Meet UI for fixing caption selectors after a Meet update. Stays on this computer. */
export function captionDebugInfo() {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const cls = (el) => (typeof el.className === 'string' ? el.className.slice(0, 120) : '');
  const pick = (el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    label: el.getAttribute('aria-label'),
    pressed: el.getAttribute('aria-pressed'),
    jsname: el.getAttribute('jsname'),
    class: cls(el),
    text: (el.innerText || '').trim().slice(0, 80),
  });
  const controls = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="switch"], [role="combobox"]')]
    .filter(shown)
    .map(pick);
  const regions = [...document.querySelectorAll('[role="region"], [aria-live]')].map((el) => ({
    ...pick(el),
    html: el.outerHTML.slice(0, 4000),
  }));
  const captionLabelled = [...document.querySelectorAll('[aria-label]')]
    .filter((el) => /caption|subtit|titr/i.test(el.getAttribute('aria-label') || ''))
    .map(pick);
  return {
    url: location.href,
    htmlLang: document.documentElement.lang,
    controls,
    regions,
    captionLabelled,
    pageTextStart: (document.body.innerText || '').slice(0, 1500),
  };
}
