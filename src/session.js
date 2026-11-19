import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { MeetBot, meetingCode, normalizeMeetUrl } from './meet/bot.js';
import { TranscriptStore, formatDuration } from './transcript/store.js';
import { generateNotes, describeNotesError } from './notes/claude.js';
import {
  defaultProvider,
  getProvider,
  nameDiarizedSpeakers,
  toTurns,
  turnsToText,
  turnsToMarkdown,
} from './stt/index.js';

export const ACTIVE_STATUSES = new Set(['starting', 'joining', 'waiting_admission', 'in_meeting', 'leaving', 'processing']);

const FILES = {
  'notes.md': 'text/markdown; charset=utf-8',
  'transcript.md': 'text/markdown; charset=utf-8',
  'transcript.txt': 'text/plain; charset=utf-8',
  'transcript.json': 'application/json',
  'audio.webm': 'audio/webm',
  'audio-transcript.md': 'text/markdown; charset=utf-8',
  'audio-transcript.json': 'application/json',
  'error.png': 'image/png',
  'log.txt': 'text/plain; charset=utf-8',
};

/** Content type for a downloadable meeting file, or null if the name is not allowed. */
export function fileType(name) {
  if (FILES[name]) return FILES[name];
  if (/^audio-\d{1,3}\.webm$/.test(name)) return 'audio/webm';
  if (/^captions-debug-\d\.json$/.test(name)) return 'application/json';
  if (/^captions-debug-\d\.png$/.test(name)) return 'image/png';
  return null;
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function makeId(code) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}_${code}`;
  let id = base;
  for (let i = 2; fs.existsSync(path.join(config.dataDir, id)); i++) id = `${base}-${i}`;
  return id.replace(/[^\w.-]/g, '_');
}

export class MeetingSession extends EventEmitter {
  /** Create a new session for a Meet URL (does not start it). */
  static create({ url, botName, title }) {
    const normalized = normalizeMeetUrl(url);
    const code = meetingCode(normalized);
    const meta = {
      id: makeId(code),
      url: normalized,
      code,
      title: (title || '').trim() || `Meeting ${code}`,
      botName: (botName || '').trim() || config.botName,
      status: 'starting',
      statusDetail: 'Starting',
      createdAt: Date.now(),
      joinedAt: null,
      endedAt: null,
      endReason: null,
      error: null,
      recordingStartedAt: null,
      recordings: [],
      warnings: [],
      health: {},
      participants: [],
      participantCount: 0,
      notesStatus: 'pending',
      notesError: null,
      notesModel: null,
      notesGeneratedAt: null,
      audioTranscriptStatus: defaultProvider() ? 'pending' : 'disabled',
      audioTranscriptProvider: null,
    };
    return new MeetingSession(meta);
  }

  /** Load a past session from its folder. */
  static load(dir) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    let segments = [];
    let origin = meta.joinedAt;
    const tPath = path.join(dir, 'transcript.json');
    if (fs.existsSync(tPath)) {
      const t = JSON.parse(fs.readFileSync(tPath, 'utf8'));
      segments = t.segments || [];
      origin = t.origin ?? origin;
    }
    const s = new MeetingSession(meta, { segments, origin, dir });
    if (ACTIVE_STATUSES.has(meta.status)) {
      // The app stopped while this meeting was running. Keep what was saved.
      s.meta.status = 'interrupted';
      s.meta.statusDetail = 'The app was closed during this meeting. The transcript saved up to that point is kept.';
      s.warn('interrupted', 'The app was closed during the meeting, so the end of the meeting was not captured.');
      s.store.finalizeAll();
      s.saveNow();
    }
    return s;
  }

  constructor(meta, { segments = [], origin = null, dir = null } = {}) {
    super();
    this.setMaxListeners(100);
    this.meta = meta;
    this.meta.warnings ||= [];
    this.meta.recordings ||= [];
    this.meta.health ||= {};
    this.dir = dir || path.join(config.dataDir, meta.id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.store = new TranscriptStore({ segments, origin });
    this.bot = null;
    this.audioStreams = new Map();
    this.saveTimer = null;
    this.lastCaptionAt = null;
    this.participantSet = new Set(meta.participants || []);
    this.done = Promise.resolve();
    this.busy = null; // running post-meeting job (notes / audio transcript)
  }

  file(name) {
    return path.join(this.dir, name);
  }

  get active() {
    return ACTIVE_STATUSES.has(this.meta.status);
  }

  availableFiles() {
    const names = fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : [];
    const order = Object.keys(FILES);
    return names
      .filter((f) => fileType(f))
      .sort((a, b) => {
        const ia = order.indexOf(a) === -1 ? order.indexOf('audio.webm') + 0.5 : order.indexOf(a);
        const ib = order.indexOf(b) === -1 ? order.indexOf('audio.webm') + 0.5 : order.indexOf(b);
        return ia - ib || a.localeCompare(b, undefined, { numeric: true });
      });
  }

  /** Audio files of this meeting, oldest first: [{ file, startedAt }]. */
  recordingParts() {
    const parts = this.meta.recordings.length
      ? this.meta.recordings
      : [{ file: 'audio.webm', startedAt: this.meta.recordingStartedAt || this.meta.joinedAt }];
    return parts.filter((p) => fs.existsSync(this.file(p.file)));
  }

  summary() {
    return {
      ...this.meta,
      speakers: this.store.speakers(),
      segmentCount: this.store.segments.length,
      files: this.availableFiles(),
      busy: this.busy,
    };
  }

  snapshot() {
    const read = (f) => (fs.existsSync(this.file(f)) ? fs.readFileSync(this.file(f), 'utf8') : null);
    return {
      meta: this.summary(),
      segments: this.store.sorted(),
      notes: read('notes.md'),
      audioTranscript: read('audio-transcript.md'),
    };
  }

  // ---- events, warnings & persistence ----------------------------------------

  broadcast(type, data) {
    this.emit('update', { type, data });
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    fs.appendFile(this.file('log.txt'), `${line}\n`, () => {});
    this.broadcast('log', { msg, ts: Date.now() });
  }

  /** Record a capture problem. It stays listed (with when it was resolved) so it's never hidden. */
  warn(code, message, { resolved = false } = {}) {
    if (this.meta.warnings.some((w) => w.code === code && !w.resolvedAt)) return;
    const now = Date.now();
    this.meta.warnings.push({ code, message, at: now, resolvedAt: resolved ? now : null });
    this.log(`Warning: ${message}`);
    this.saveSoon();
    this.broadcast('meta', this.summary());
  }

  resolveWarning(code) {
    const w = this.meta.warnings.find((x) => x.code === code && !x.resolvedAt);
    if (!w) return;
    w.resolvedAt = Date.now();
    this.log(`Resolved: ${w.message}`);
    this.saveSoon();
    this.broadcast('meta', this.summary());
  }

  setStatus(status, detail) {
    this.meta.status = status;
    if (detail !== undefined) this.meta.statusDetail = detail;
    this.log(`Status: ${status}${detail ? ` (${detail})` : ''}`);
    this.saveNow();
    this.broadcast('meta', this.summary());
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 2000);
  }

  saveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.meta.participants = [...this.participantSet];
    writeAtomic(this.file('meta.json'), JSON.stringify(this.meta, null, 2));
    writeAtomic(this.file('transcript.json'), JSON.stringify(this.store.toJSON(), null, 2));
    writeAtomic(this.file('transcript.md'), this.store.toMarkdown(this.meta));
    writeAtomic(this.file('transcript.txt'), this.store.toText());
  }

  // ---- live capture ----------------------------------------------------------

  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.saveNow();
    this.log(`Meeting ${this.meta.url} — bot "${this.meta.botName}"`);
    const bot = new MeetBot({ url: this.meta.url, botName: this.meta.botName, screenshotPath: this.file('error.png') });
    this.bot = bot;

    bot.on('status', (status, detail) => this.setStatus(status, detail));
    bot.on('log', (msg) => this.log(msg));
    bot.on('joined', (ts) => {
      this.meta.joinedAt = ts;
      this.store.setOrigin(ts);
      this.saveNow();
    });
    bot.on('recording', (rec) => this.onRecording(rec));
    bot.on('audio', (id, buf) => this.onAudio(id, buf));
    bot.on('caption', (snap) => {
      const changed = this.store.apply(snap);
      if (!snap.removed && changed.length) this.lastCaptionAt = Date.now();
      for (const seg of changed) {
        this.broadcast('segment', seg);
        if (seg.final) this.emit('final-segment', seg);
      }
      if (changed.length) this.saveSoon();
    });
    bot.on('health', (h) => this.onHealth(h));
    bot.on('dropped', () =>
      this.warn('dropped', 'The bot dropped out of the call. Anything said until it rejoined was not captured.'),
    );
    bot.on('rejoined', () => this.resolveWarning('dropped'));
    bot.on('participants', ({ count, names }) => {
      let changed = count !== this.meta.participantCount;
      this.meta.participantCount = count;
      for (const n of names) {
        if (!this.participantSet.has(n)) {
          this.participantSet.add(n);
          changed = true;
        }
      }
      if (changed) {
        this.meta.participants = [...this.participantSet];
        this.broadcast('meta', this.summary());
        this.saveSoon();
      }
    });

    this.done = bot
      .run()
      .then((result) => this.finish(result))
      .catch((err) => {
        this.meta.error = err.message;
        this.setStatus('failed', err.message);
      });
    return this.done;
  }

  stop() {
    if (this.bot && this.active) {
      this.log('Stop requested.');
      this.bot.stop('Stopped from the app');
    }
  }

  onRecording({ id, startedAt, restarted }) {
    if (this.meta.recordings.some((r) => r.id === id)) return;
    const n = this.meta.recordings.length + 1;
    const file = n === 1 ? 'audio.webm' : `audio-${n}.webm`;
    this.meta.recordings.push({ id, file, startedAt });
    if (n === 1) this.meta.recordingStartedAt = startedAt;
    this.log(`Audio recording started (${file}).`);
    if (restarted) {
      this.warn(
        `audio_restarted_${n}`,
        `The audio recorder stopped and was restarted, so the recording has a gap and continues in ${file}.`,
        { resolved: true },
      );
    }
    this.saveSoon();
  }

  onAudio(id, buf) {
    if (!this.meta.recordings.some((r) => r.id === id)) this.onRecording({ id, startedAt: Date.now() - 5000 });
    let stream = this.audioStreams.get(id);
    if (!stream) {
      const part = this.meta.recordings.find((r) => r.id === id);
      stream = fs.createWriteStream(this.file(part.file), { flags: 'a' });
      this.audioStreams.set(id, stream);
    }
    stream.write(buf);
    const part = this.meta.recordings.find((r) => r.id === id);
    part.bytes = (part.bytes || 0) + buf.length;
  }

  /** Called every ~10 s while in the call with what the bot sees. Raises/clears warnings. */
  onHealth({ captionsOn, recorder }) {
    const now = Date.now();
    const h = this.meta.health;
    h.checkedAt = now;
    h.captionsOn = captionsOn;
    h.lastCaptionAt = this.lastCaptionAt;
    h.recording = Boolean(recorder && recorder.state === 'recording');
    h.audioStreams = recorder ? recorder.tracks : 0;
    h.lastSoundAt = recorder?.lastSoundAt || h.lastSoundAt || null;
    if (recorder?.lastSoundAt) this.meta.audioHadSound = true;

    if (captionsOn) this.resolveWarning('captions_off');
    else this.warn('captions_off', 'Captions are off and the bot could not turn them back on. Speech is not being written down.');

    if (config.recordAudio) {
      const inCallFor = now - (this.meta.joinedAt || now);
      if (h.recording) this.resolveWarning('audio_off');
      else this.warn('audio_off', 'The audio recorder is not running, so nothing is being recorded.');

      if (recorder && recorder.tracks > 0) this.resolveWarning('audio_no_streams');
      else if (recorder && inCallFor > 60_000) {
        this.warn('audio_no_streams', 'No meeting audio is reaching the recorder, so the recording is silent.');
      }

      const talking = this.lastCaptionAt && now - this.lastCaptionAt < 60_000;
      const recordingLongEnough = recorder && now - recorder.startedAt > 90_000;
      const silentFor = recorder?.lastSoundAt ? now - recorder.lastSoundAt : Infinity;
      if (talking && recordingLongEnough && silentFor > 90_000) {
        this.warn('audio_silent', 'People are talking (captions are coming in) but the recording is silent.');
      } else if (silentFor < 30_000) {
        this.resolveWarning('audio_silent');
      }
    }
    this.broadcast('meta', this.summary());
  }

  // ---- after the meeting -----------------------------------------------------

  async finish(result) {
    for (const seg of this.store.finalizeAll()) {
      this.broadcast('segment', seg);
      this.emit('final-segment', seg);
    }
    await Promise.all([...this.audioStreams.values()].map((s) => new Promise((r) => s.end(r))));
    this.audioStreams.clear();
    this.meta.endedAt = result.endedAt;
    this.meta.endReason = result.reason || result.error;

    if (!result.joinedAt) {
      this.meta.error = result.error;
      this.meta.notesStatus = 'skipped';
      if (result.code === 'cancelled') this.setStatus('cancelled', 'Stopped before the bot joined');
      else this.setStatus('failed', result.error || 'Could not join the meeting');
      return;
    }
    if (result.error) {
      this.meta.error = result.error;
      this.warn('bot_error', `The bot hit an error during the meeting: ${result.error}`);
    }

    // Final capture checks, so a meeting can't look "finished" when capture failed.
    const minutes = (this.meta.endedAt - this.meta.joinedAt) / 60_000;
    if (!this.store.segments.length) {
      this.warn('no_transcript', 'No captions were captured, so the caption transcript is empty.');
    }
    if (config.recordAudio) {
      const bytes = this.meta.recordings.reduce((a, r) => a + (r.bytes || 0), 0);
      if (bytes < 20_000) this.warn('no_audio', 'Little or no audio was recorded.');
      else if (!this.meta.audioHadSound && minutes > 1) {
        this.warn('audio_silent_all', 'The audio recording is silent for the whole meeting.');
      }
    }
    // Live problems still open when the meeting ended lasted until the end (they were not fixed).
    for (const w of this.meta.warnings) {
      if (!w.resolvedAt && /^(captions_off|audio_off|audio_silent|audio_no_streams|dropped)$/.test(w.code)) w.untilEnd = true;
    }

    this.setStatus('processing', `${this.meta.endReason || 'Meeting finished'}. Writing transcript and notes`);
    this.saveNow();
    const provider = defaultProvider();
    if (provider) await this.transcribeAudio(provider);
    else if (this.meta.audioTranscriptStatus === 'pending') this.meta.audioTranscriptStatus = 'disabled';
    await this.makeNotes();
    this.setStatus('done', this.meta.endReason || 'Meeting finished');
  }

  /** Transcribe the recorded audio with Soniox or Deepgram. Returns true on success. */
  async transcribeAudio(providerId) {
    const parts = this.recordingParts().filter((p) => fs.statSync(this.file(p.file)).size >= 1000);
    if (!parts.length) {
      this.meta.audioTranscriptStatus = 'skipped';
      this.log('No audio recording to transcribe.');
      return false;
    }
    let provider;
    try {
      provider = getProvider(providerId);
    } catch (err) {
      this.meta.audioTranscriptStatus = 'failed';
      this.meta.audioTranscriptError = err.message;
      this.log(err.message);
      return false;
    }
    const previousStatus = this.meta.audioTranscriptStatus;
    try {
      this.meta.audioTranscriptStatus = 'running';
      this.meta.audioTranscriptError = null;
      this.broadcast('meta', this.summary());
      this.log(`Transcribing the audio recording with ${provider.label}`);
      const captionSegments = this.store.sorted();
      const results = [];
      for (const part of parts) {
        const startedAt = part.startedAt || this.meta.joinedAt;
        const utterances = await provider.transcribe(this.file(part.file));
        results.push({ utterances, startedAt, nameOf: nameDiarizedSpeakers(utterances, captionSegments, startedAt) });
      }
      const turns = toTurns(results);
      const origin = this.store.origin0;
      writeAtomic(this.file('audio-transcript.json'), JSON.stringify({ provider: provider.id, turns }, null, 2));
      writeAtomic(this.file('audio-transcript.md'), turnsToMarkdown(turns, origin, { title: this.meta.title, providerLabel: provider.label }));
      this.meta.audioTranscriptStatus = 'done';
      this.meta.audioTranscriptProvider = provider.id;
      this.log(`Audio transcript ready (${provider.label}).`);
      this.saveNow();
      this.broadcast('audio-transcript', fs.readFileSync(this.file('audio-transcript.md'), 'utf8'));
      this.broadcast('meta', this.summary());
      return true;
    } catch (err) {
      // Keep an earlier audio transcript if there is one.
      const hadOne = fs.existsSync(this.file('audio-transcript.json'));
      this.meta.audioTranscriptStatus = hadOne && previousStatus === 'done' ? 'done' : 'failed';
      this.meta.audioTranscriptError = `${provider.label}: ${err.message}${hadOne ? ' (the previous audio transcript was kept)' : ''}`;
      this.log(`Audio transcription failed: ${err.message}`);
      this.saveNow();
      this.broadcast('meta', this.summary());
      return false;
    }
  }

  audioTranscriptText() {
    const f = this.file('audio-transcript.json');
    if (!fs.existsSync(f)) return '';
    try {
      const { turns } = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(turns) ? turnsToText(turns, this.store.origin0) : '';
    } catch {
      return '';
    }
  }

  notesHeader() {
    const m = this.meta;
    const people = [...new Set([...this.store.speakers(), ...this.participantSet])].filter(
      (n) => n !== m.botName && n !== 'Unknown speaker',
    );
    const lines = [`# Meeting notes — ${m.title}`, ''];
    if (m.joinedAt) lines.push(`- **Date:** ${new Date(m.joinedAt).toLocaleString()}`);
    if (m.joinedAt && m.endedAt) lines.push(`- **Duration:** ${formatDuration(m.endedAt - m.joinedAt)}`);
    if (people.length) lines.push(`- **Participants:** ${people.join(', ')}`);
    lines.push(`- **Meeting link:** ${m.url}`, '- **Full transcript:** transcript.md');
    if (m.warnings.length) {
      lines.push('- **Capture issues — parts of this meeting may be missing:**');
      for (const w of m.warnings) lines.push(`  - ${w.message}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  speakingTable() {
    const stats = this.store.stats();
    if (!stats.length) return '';
    const rows = stats.map((s) => `| ${s.speaker} | ${s.share}% | ${s.words} | ${s.turns} |`);
    return ['## Speaking time', '', '| Speaker | Share of words | Words | Caption segments |', '|---|---|---|---|', ...rows, ''].join('\n');
  }

  async makeNotes() {
    const transcript = this.store.toText();
    const audioTranscript = this.audioTranscriptText();
    const hadNotes = Boolean(this.meta.notesGeneratedAt) && fs.existsSync(this.file('notes.md'));
    this.meta.notesError = null;

    if (!transcript.trim() && !audioTranscript.trim()) {
      this.meta.notesStatus = 'skipped';
      this.meta.notesError = 'No speech was captured, so there is nothing to summarize.';
      writeAtomic(this.file('notes.md'), `${this.notesHeader()}\n---\n\n_No speech was captured in this meeting._\n`);
      this.broadcast('notes', fs.readFileSync(this.file('notes.md'), 'utf8'));
      return;
    }

    this.meta.notesStatus = 'generating';
    this.broadcast('meta', this.summary());
    this.log(`Generating notes with ${config.notesModel}`);
    let body;
    try {
      const m = this.meta;
      const result = await generateNotes({
        title: m.title,
        date: m.joinedAt ? new Date(m.joinedAt).toLocaleString() : undefined,
        duration: m.joinedAt && m.endedAt ? formatDuration(m.endedAt - m.joinedAt) : undefined,
        participants: [...this.participantSet],
        transcript,
        audioTranscript,
        captureIssues: m.warnings.map((w) => w.message),
      });
      body = result.markdown;
      this.meta.notesStatus = 'done';
      this.meta.notesModel = result.model;
      this.meta.notesGeneratedAt = Date.now();
      this.log('Notes ready.');
    } catch (err) {
      const reason = describeNotesError(err);
      this.log(`Notes failed: ${reason}`);
      if (hadNotes) {
        // A failed retry must not destroy notes that were generated before.
        this.meta.notesStatus = 'done';
        this.meta.notesError = `Regenerating the notes failed (${reason}). The previous notes were kept.`;
        this.saveNow();
        this.broadcast('meta', this.summary());
        return;
      }
      this.meta.notesStatus = 'failed';
      this.meta.notesError = reason;
      body = `_AI notes could not be generated: ${reason}_\n\nThe full transcript is saved in transcript.md.`;
    }
    const notes = [this.notesHeader(), '---', '', body.trim(), '', '---', '', this.speakingTable()].join('\n');
    writeAtomic(this.file('notes.md'), notes);
    this.saveNow();
    this.broadcast('notes', notes);
    this.broadcast('meta', this.summary());
  }

  /** Run a post-meeting job (notes or audio transcript) for a finished meeting, one at a time. */
  // Checks run synchronously so callers get an immediate error; the job itself runs async.
  runJob(name, fn) {
    if (this.active) throw new Error('Wait until the meeting has finished.');
    if (this.busy) throw new Error(`Already busy: ${this.busy}.`);
    this.busy = name;
    this.broadcast('meta', this.summary());
    return (async () => {
      try {
        return await fn();
      } finally {
        this.busy = null;
        this.broadcast('meta', this.summary());
      }
    })();
  }

  /** Delete this meeting's folder (recordings, transcripts, notes). Not allowed while it runs. */
  remove() {
    if (this.active || this.busy) {
      const err = new Error('This meeting is still running or busy. Stop it first.');
      err.status = 409;
      throw err;
    }
    if (this.saveTimer) clearTimeout(this.saveTimer);
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch (err) {
      const e = new Error(
        /EBUSY|EPERM/.test(err.code)
          ? 'A file of this meeting is open in another program (e.g. an audio player). Close it and try again.'
          : `Could not delete the meeting: ${err.message}`,
      );
      e.status = 409;
      throw e;
    }
    this.broadcast('deleted', { id: this.meta.id });
  }

  regenerateNotes() {
    return this.runJob('writing notes', () => this.makeNotes());
  }

  retranscribeAudio(providerId) {
    getProvider(providerId); // validate before starting
    return this.runJob('transcribing audio', () => this.transcribeAudio(providerId));
  }
}
