import { mergeCaptionText, looksLikeContinuation, wordCount } from './merge.js';

export function formatOffset(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function formatDuration(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/**
 * Holds the speaker-attributed transcript built from live caption snapshots.
 * Each snapshot is { key, speaker, text, ts } where `key` identifies one caption block on
 * the Meet page. A block becomes final when it disappears from the page.
 */
export class TranscriptStore {
  constructor({ segments = [], origin = null } = {}) {
    this.segments = segments.map((s) => ({ ...s }));
    this.byId = new Map(this.segments.map((s) => [s.id, s]));
    this.keyToId = new Map();
    this.seq = this.segments.reduce((max, s) => Math.max(max, Number(String(s.id).slice(1)) || 0), 0);
    this.origin = origin; // epoch ms that timestamps are relative to (when the bot entered the call)
  }

  setOrigin(ts) {
    this.origin = ts;
  }

  /** Apply one caption snapshot. Returns the changed segments (to broadcast). */
  apply({ key, speaker, text, ts, removed }) {
    ts = ts || Date.now();
    if (removed) {
      const seg = this.byId.get(this.keyToId.get(key));
      this.keyToId.delete(key);
      if (seg && !seg.final) {
        seg.final = true;
        return [seg];
      }
      return [];
    }

    text = (text || '').replace(/\s+/g, ' ').trim();
    speaker = (speaker || 'Unknown speaker').trim();
    if (!text) return [];

    const changed = [];
    let seg = this.byId.get(this.keyToId.get(key));

    // Meet re-used the block for a different speaker: close the old segment.
    if (seg && seg.speaker !== speaker) {
      if (!seg.final) {
        seg.final = true;
        changed.push(seg);
      }
      this.keyToId.delete(key);
      seg = undefined;
    }

    if (!seg) {
      // Meet sometimes replaces a caption element with a new one showing the same text. Treat the
      // new element as the old segment only when that is clearly what happened: it is the latest
      // segment overall (nobody spoke in between), its element just disappeared, and the text is
      // long enough that a match is not a coincidence. Short repeats like "Yes" stay separate.
      const last = this.segments[this.segments.length - 1];
      const inUse = last && [...this.keyToId.values()].includes(last.id);
      const reRender =
        last && !inUse && last.final && last.speaker === speaker && ts - last.end < 5_000 &&
        wordCount(text) >= 3 && looksLikeContinuation(last.text, text);
      seg = reRender ? last : undefined;
      if (seg) {
        seg.final = false;
      } else {
        seg = { id: `s${++this.seq}`, speaker, text: '', start: ts, end: ts, final: false };
        this.segments.push(seg);
        this.byId.set(seg.id, seg);
      }
      this.keyToId.set(key, seg.id);
    }

    const merged = mergeCaptionText(seg.text, text);
    if (merged !== seg.text || seg.end !== ts) {
      seg.text = merged;
      seg.end = ts;
      changed.push(seg);
    }
    return changed;
  }

  finalizeAll() {
    const changed = [];
    for (const seg of this.segments) {
      if (!seg.final) {
        seg.final = true;
        changed.push(seg);
      }
    }
    this.keyToId.clear();
    return changed;
  }

  get origin0() {
    return this.origin ?? this.segments[0]?.start ?? Date.now();
  }

  sorted() {
    return [...this.segments].filter((s) => s.text).sort((a, b) => a.start - b.start);
  }

  speakers() {
    return [...new Set(this.sorted().map((s) => s.speaker))];
  }

  /** Consecutive segments from the same speaker merged into turns, for reading. */
  turns() {
    const turns = [];
    for (const s of this.sorted()) {
      const last = turns[turns.length - 1];
      if (last && last.speaker === s.speaker && s.start - last.end < 30_000) {
        last.text += ` ${s.text}`;
        last.end = Math.max(last.end, s.end);
      } else {
        turns.push({ speaker: s.speaker, text: s.text, start: s.start, end: s.end });
      }
    }
    return turns;
  }

  stats() {
    const per = new Map();
    for (const s of this.sorted()) {
      const p = per.get(s.speaker) || { speaker: s.speaker, words: 0, ms: 0, turns: 0 };
      p.words += s.text.split(/\s+/).filter(Boolean).length;
      p.ms += Math.max(1000, s.end - s.start);
      p.turns += 1;
      per.set(s.speaker, p);
    }
    const totalWords = [...per.values()].reduce((a, p) => a + p.words, 0) || 1;
    return [...per.values()]
      .map((p) => ({ ...p, share: Math.round((p.words / totalWords) * 100) }))
      .sort((a, b) => b.words - a.words);
  }

  /** Plain text, one line per turn: "[00:01:02] Name: text". Used for the notes prompt. */
  toText() {
    const o = this.origin0;
    return this.turns().map((t) => `[${formatOffset(t.start - o)}] ${t.speaker}: ${t.text}`).join('\n');
  }

  toMarkdown(meta = {}) {
    const o = this.origin0;
    const lines = [`# Transcript${meta.title ? ` — ${meta.title}` : ''}`, ''];
    if (meta.joinedAt) lines.push(`- **Date:** ${new Date(meta.joinedAt).toLocaleString()}`);
    if (meta.joinedAt && meta.endedAt) lines.push(`- **Duration:** ${formatDuration(meta.endedAt - meta.joinedAt)}`);
    if (meta.url) lines.push(`- **Meeting link:** ${meta.url}`);
    const speakers = this.speakers();
    if (speakers.length) lines.push(`- **Speakers:** ${speakers.join(', ')}`);
    lines.push('', '---', '');
    const turns = this.turns();
    if (!turns.length) lines.push('_No speech was captured._');
    for (const t of turns) lines.push(`**[${formatOffset(t.start - o)}] ${t.speaker}:** ${t.text}`, '');
    return lines.join('\n');
  }

  toJSON() {
    return { origin: this.origin, segments: this.sorted() };
  }
}
