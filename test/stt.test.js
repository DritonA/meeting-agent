import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensToUtterances } from '../src/stt/soniox.js';
import { nameDiarizedSpeakers, toTurns, turnsToText } from '../src/stt/index.js';

test('soniox: tokens are grouped into speaker utterances', () => {
  const utts = tokensToUtterances([
    { text: 'Mi', start_ms: 0, end_ms: 100, speaker: '1' },
    { text: 'rë', start_ms: 100, end_ms: 200, speaker: '1' },
    { text: 'dita', start_ms: 250, end_ms: 500, speaker: '1' },
    { text: ' Faleminderit', start_ms: 900, end_ms: 1500, speaker: '2' },
    { text: ' Po', start_ms: 9000, end_ms: 9200, speaker: '2' }, // long pause -> new utterance
  ]);
  assert.deepEqual(
    utts.map((u) => [u.speaker, u.text, u.start]),
    [['1', 'Mirëdita', 0], ['2', 'Faleminderit', 0.9], ['2', 'Po', 9]],
  );
});

test('diarized speakers are named from overlapping captions', () => {
  const fileStart = 10_000;
  const utterances = [
    { start: 0, end: 2, speaker: '1', text: 'hello' },
    { start: 3, end: 5, speaker: '2', text: 'hi' },
    { start: 6, end: 7, speaker: '3', text: 'unknown voice' },
  ];
  const captions = [
    { speaker: 'Alice', start: 10_500, end: 12_500 },
    { speaker: 'Bob', start: 13_200, end: 15_500 },
  ];
  const nameOf = nameDiarizedSpeakers(utterances, captions, fileStart);
  assert.equal(nameOf('1'), 'Alice');
  assert.equal(nameOf('2'), 'Bob');
  assert.equal(nameOf('3'), 'Speaker 3');
});

test('turns from several recording parts are placed on one timeline', () => {
  const turns = toTurns([
    { startedAt: 1000, nameOf: () => 'Alice', utterances: [{ start: 0, end: 1, speaker: '1', text: 'first part' }] },
    { startedAt: 60_000, nameOf: () => 'Bob', utterances: [{ start: 1, end: 2, speaker: '1', text: 'second part' }] },
  ]);
  assert.equal(turnsToText(turns, 1000), '[00:00:00] Alice: first part\n[00:01:00] Bob: second part');
});
