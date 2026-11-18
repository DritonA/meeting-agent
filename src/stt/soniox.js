import fs from 'node:fs/promises';
import path from 'node:path';

// Soniox async transcription (https://docs.soniox.com):
//   upload file -> create transcription -> poll until completed -> fetch tokens -> clean up.
const BASE = process.env.SONIOX_API_BASE || 'https://api.soniox.com/v1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(apiKey, method, route, body) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${route}`, { method, headers, body: payload });
  if (!res.ok) throw new Error(`Soniox ${method} ${route} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

/** Group Soniox tokens (word pieces with timestamps) into speaker utterances. */
export function tokensToUtterances(tokens) {
  const out = [];
  for (const tok of tokens) {
    if (!tok || typeof tok.text !== 'string') continue;
    if (tok.translation_status === 'translation') continue; // only original speech
    const speaker = String(tok.speaker ?? '1');
    const start = (tok.start_ms ?? 0) / 1000;
    const end = (tok.end_ms ?? tok.start_ms ?? 0) / 1000;
    const last = out[out.length - 1];
    // A new utterance when the speaker changes or after a long pause.
    if (last && last.speaker === speaker && start - last.end < 2.5) {
      last.text += tok.text;
      last.end = end;
    } else {
      out.push({ start, end, speaker, text: tok.text });
    }
  }
  return out.map((u) => ({ ...u, text: u.text.replace(/\s+/g, ' ').trim() })).filter((u) => u.text);
}

/**
 * Transcribe one audio file with Soniox (speaker diarization on).
 * Returns utterances [{ start, end, speaker, text }], start/end in seconds from the file start.
 */
export async function transcribeWithSoniox(audioPath, { apiKey, language, model }) {
  const data = await fs.readFile(audioPath);
  const form = new FormData();
  const types = { '.webm': 'audio/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
  const type = types[path.extname(audioPath).toLowerCase()] || 'application/octet-stream';
  form.append('file', new Blob([data], { type }), path.basename(audioPath));
  const file = await call(apiKey, 'POST', '/files', form);

  let transcriptionId = null;
  try {
    const job = await call(apiKey, 'POST', '/transcriptions', {
      model,
      file_id: file.id,
      enable_speaker_diarization: true,
      ...(language ? { language_hints: [language] } : {}),
      client_reference_id: path.basename(path.dirname(audioPath)).slice(0, 200),
    });
    transcriptionId = job.id;

    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    for (;;) {
      const status = await call(apiKey, 'GET', `/transcriptions/${transcriptionId}`);
      if (status.status === 'completed') break;
      if (status.status === 'error') {
        throw new Error(`Soniox could not transcribe the audio: ${status.error_message || status.error_type || 'unknown error'}`);
      }
      if (Date.now() > deadline) throw new Error('Soniox transcription timed out.');
      await wait(3000);
    }
    const transcript = await call(apiKey, 'GET', `/transcriptions/${transcriptionId}/transcript`);
    return tokensToUtterances(transcript?.tokens || []);
  } finally {
    // Don't leave meeting audio stored at Soniox.
    if (transcriptionId) await call(apiKey, 'DELETE', `/transcriptions/${transcriptionId}`).catch(() => {});
    await call(apiKey, 'DELETE', `/files/${file.id}`).catch(() => {});
  }
}
