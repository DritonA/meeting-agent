import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

const SYSTEM_PROMPT = `You write meeting notes from Google Meet transcripts.

The transcript comes from automatic live captions, so it can contain recognition errors, missing words, and
occasionally a line attributed to the wrong person. Each line is "[hh:mm:ss] Speaker Name: what they said".

Write notes that someone who missed the meeting can rely on:
- Use only what is in the transcript. Do not invent facts, owners, numbers, or dates. If something is unclear, say so.
- Keep speaker names exactly as they appear in the transcript.
- Quietly fix obvious caption errors (misheard words) when the meaning is clear; do not mention each fix.
- Attribute important statements, proposals, and commitments to the person who made them.
- An action item needs a clear task. Record the owner and due date only when the transcript states or clearly implies them; otherwise write "Unassigned" / "Not set".
- Be complete but not padded: cover every topic that was discussed, in the order it came up.

Respond in Markdown using exactly these sections (omit a section only if it would be empty, except Summary):

## Summary
A short paragraph (3-6 sentences) on the purpose of the meeting and the outcome.

## Topics discussed
One ### sub-heading per topic, in order, with bullet points of what was said and by whom, and the timestamp where the topic starts.

## Decisions
Bullet list of decisions that were made, with who made or agreed to them.

## Action items
A Markdown table with columns: Owner | Action | Due | Context (timestamp).

## Open questions and risks
Bullet list of unresolved questions, blockers, concerns.

## Per-participant highlights
One bullet per speaker with their main contributions and commitments.

Write the notes, including the section headings, in the language the user asks for; if none is given, use the
language the meeting was held in.`;

/**
 * Generate meeting notes (Markdown) from the transcript. Throws if the API call fails.
 * @param {{ title?: string, date?: string, duration?: string, participants?: string[],
 *           transcript: string, audioTranscript?: string }} input
 */
export async function generateNotes(input) {
  const client = new Anthropic();
  const parts = [
    'Here is the meeting to summarize.',
    '',
    `Title: ${input.title || 'Untitled meeting'}`,
    input.date ? `Date: ${input.date}` : null,
    input.duration ? `Duration: ${input.duration}` : null,
    input.participants?.length ? `Participants seen in the call: ${input.participants.join(', ')}` : null,
    input.captureIssues?.length
      ? `Capture problems during this meeting (parts may be missing; mention this briefly in the Summary): ${input.captureIssues.join(' ')}`
      : null,
    '',
    '<transcript source="live captions, speaker-attributed">',
    input.transcript || '(empty — captions were not captured)',
    '</transcript>',
  ];
  if (input.audioTranscript) {
    parts.push(
      '',
      'A second transcript made from the meeting audio recording is included below. Its speaker names were matched',
      'to the captions automatically and may be less reliable, but it can fill gaps where captions missed speech.',
      '<audio_transcript>',
      input.audioTranscript,
      '</audio_transcript>',
    );
  }
  parts.push(
    '',
    config.notesLanguage
      ? `Write the meeting notes in ${config.notesLanguage}, including the section headings.`
      : 'Write the meeting notes now.',
  );

  const model = config.notesModel;
  const params = {
    model,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: parts.filter((p) => p !== null).join('\n') }],
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  const stream = client.beta.messages.stream(params);
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to summarize this transcript.');
  }
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('Claude returned empty notes.');
  const truncated = message.stop_reason === 'max_tokens' ? '\n\n_(Notes were cut off because they hit the length limit.)_' : '';
  return { markdown: text + truncated, model: message.model, usage: message.usage };
}

export function describeNotesError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Claude API key missing or invalid. Set ANTHROPIC_API_KEY in .env, then use "Regenerate notes".';
  }
  if (err instanceof Anthropic.RateLimitError) return 'Claude API rate limit hit. Try "Regenerate notes" in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`;
  if (/api key|apiKey|authToken/i.test(String(err?.message))) {
    return 'Claude API key missing. Set ANTHROPIC_API_KEY in .env, then use "Regenerate notes".';
  }
  return err?.message || String(err);
}
