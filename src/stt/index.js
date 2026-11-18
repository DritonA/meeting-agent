import { config } from '../config.js';
import { formatOffset } from '../transcript/store.js';
import { transcribeWithDeepgram } from './deepgram.js';
import { transcribeWithSoniox } from './soniox.js';

// Speech-to-text services that can transcribe the recorded meeting audio.
const PROVIDERS = {
  soniox: {
    label: 'Soniox',
    configured: () => Boolean(config.sonioxKey),
    transcribe: (file) =>
      transcribeWithSoniox(file, { apiKey: config.sonioxKey, language: config.transcriptionLanguage, model: config.sonioxModel }),
  },
  deepgram: {
    label: 'Deepgram',
    configured: () => Boolean(config.deepgramKey),
    transcribe: (file) => transcribeWithDeepgram(file, { apiKey: config.deepgramKey, language: config.transcriptionLanguage }),
  },
};

/** Providers that have an API key set: [{ id, label }]. */
export function availableProviders() {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.configured())
    .map(([id, p]) => ({ id, label: p.label }));
}

/** The provider to use after each meeting (TRANSCRIPTION_PROVIDER, or the first one with a key). */
export function defaultProvider() {
  const wanted = config.transcriptionProvider;
  if (wanted === 'none') return null;
  if (wanted) return PROVIDERS[wanted]?.configured() ? wanted : null;
  return availableProviders()[0]?.id || null;
}

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown transcription provider "${id}". Use soniox or deepgram.`);
  if (!p.configured()) throw new Error(`${p.label} has no API key. Set ${id.toUpperCase()}_API_KEY in .env.`);
  return { id, ...p };
}

/**
 * Diarization labels speakers "1", "2", …; captions know real names. For each label, pick the
 * caption speaker whose segments overlap that label's speech the most.
 * `fileStartedAt` is the epoch ms when this audio file started recording.
 */
export function nameDiarizedSpeakers(utterances, captionSegments, fileStartedAt) {
  const votes = new Map();
  for (const u of utterances) {
    const us = fileStartedAt + u.start * 1000;
    const ue = fileStartedAt + u.end * 1000 + 2000; // captions lag speech by ~1-2 s
    for (const s of captionSegments) {
      const overlap = Math.min(ue, s.end + 1000) - Math.max(us, s.start);
      if (overlap <= 0) continue;
      const m = votes.get(u.speaker) || new Map();
      m.set(s.speaker, (m.get(s.speaker) || 0) + overlap);
      votes.set(u.speaker, m);
    }
  }
  const names = new Map();
  const used = new Set();
  const ranked = [...votes.entries()]
    .map(([spk, m]) => [spk, [...m.entries()].sort((a, b) => b[1] - a[1])])
    .sort((a, b) => (b[1][0]?.[1] || 0) - (a[1][0]?.[1] || 0));
  for (const [spk, options] of ranked) {
    const pick = options.find(([name]) => !used.has(name));
    if (pick) {
      names.set(spk, pick[0]);
      used.add(pick[0]);
    }
  }
  return (spk) => names.get(spk) || `Speaker ${spk}`;
}

/** Turn per-file utterances into named turns with absolute (epoch ms) start times. */
export function toTurns(parts) {
  const turns = [];
  for (const { utterances, startedAt, nameOf } of parts) {
    for (const u of utterances) {
      const name = nameOf(u.speaker);
      const start = startedAt + u.start * 1000;
      const last = turns[turns.length - 1];
      if (last && last.name === name && start - last.end < 30_000) {
        last.text += ` ${u.text}`;
        last.end = startedAt + u.end * 1000;
      } else {
        turns.push({ name, start, end: startedAt + u.end * 1000, text: u.text });
      }
    }
  }
  return turns.sort((a, b) => a.start - b.start);
}

export function turnsToText(turns, origin) {
  return turns.map((t) => `[${formatOffset(t.start - origin)}] ${t.name}: ${t.text}`).join('\n');
}

export function turnsToMarkdown(turns, origin, { title, providerLabel }) {
  const lines = [
    `# Audio transcript${title ? ` — ${title}` : ''}`,
    '',
    `_Made from the meeting audio recording by ${providerLabel}, with speaker separation. ` +
      'Names were matched to the live captions automatically and can be wrong._',
    '',
    '---',
    '',
  ];
  if (!turns.length) lines.push('_No speech was found in the recording._');
  for (const t of turns) lines.push(`**[${formatOffset(t.start - origin)}] ${t.name}:** ${t.text}`, '');
  return lines.join('\n');
}
