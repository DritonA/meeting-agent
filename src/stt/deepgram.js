import fs from 'node:fs/promises';

/**
 * Transcribe one audio file with Deepgram (speaker diarization on).
 * Returns utterances [{ start, end, speaker, text }], start/end in seconds from the file start,
 * speaker as a string label ("1", "2", …).
 */
export async function transcribeWithDeepgram(audioPath, { apiKey, language }) {
  const audio = await fs.readFile(audioPath);
  const params = new URLSearchParams({
    model: 'nova-3',
    diarize: 'true',
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
  });
  if (language) params.set('language', language);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/webm' },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return (json.results?.utterances || []).map((u) => ({
    start: u.start,
    end: u.end,
    speaker: String((u.speaker ?? 0) + 1),
    text: (u.transcript || '').trim(),
  }));
}
