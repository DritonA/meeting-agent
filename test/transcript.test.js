import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCaptionText } from '../src/transcript/merge.js';
import { TranscriptStore } from '../src/transcript/store.js';

test('merge: growing caption replaces snapshot', () => {
  assert.equal(mergeCaptionText('Hello every', 'Hello everyone, welcome'), 'Hello everyone, welcome');
});

test('merge: single partial word grows', () => {
  assert.equal(mergeCaptionText('Hel', 'Hello'), 'Hello');
});

test('merge: tail revision is accepted', () => {
  assert.equal(
    mergeCaptionText('So the plan for next week is too', 'So the plan for next week is to ship'),
    'So the plan for next week is to ship',
  );
});

test('merge: front-trimmed caption keeps earlier words', () => {
  const prev = 'We need to finish the migration before Friday and then we can start testing';
  const next = 'before Friday and then we can start testing the new billing flow';
  assert.equal(
    mergeCaptionText(prev, next),
    'We need to finish the migration before Friday and then we can start testing the new billing flow',
  );
});

test('merge: first-word revision does not duplicate', () => {
  assert.equal(
    mergeCaptionText('Hello there team how are you all doing', 'Hi there team how are you all doing today'),
    'Hi there team how are you all doing today',
  );
});

test('merge: unrelated text is appended, never dropped', () => {
  assert.equal(mergeCaptionText('Alpha beta gamma', 'delta epsilon zeta'), 'Alpha beta gamma delta epsilon zeta');
});

test('merge: front trim plus tail revision keeps the trimmed words', () => {
  const prev = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
  // Meet dropped "one".."five" from the block and revised the last two words.
  const next = 'six seven eight nine ten eleven twelve thirteen fourteen fifty sixty and more';
  assert.equal(
    mergeCaptionText(prev, next),
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifty sixty and more',
  );
});

test('merge: repeated phrase anchors to the end, not the start', () => {
  assert.equal(mergeCaptionText('we can ship it and then we can ship it', 'then we can ship it on Friday'),
    'we can ship it and then we can ship it on Friday');
});

test('merge: a shorter snapshot never erases captured words', () => {
  const prev = 'please send the report to the whole team by Monday morning';
  assert.equal(mergeCaptionText(prev, 'please send the report'), prev);
});

test('store: builds speaker turns from snapshots', () => {
  const st = new TranscriptStore({ origin: 1000 });
  st.apply({ key: 'b1', speaker: 'Alice', text: 'Hi', ts: 2000 });
  st.apply({ key: 'b1', speaker: 'Alice', text: 'Hi everyone', ts: 3000 });
  st.apply({ key: 'b2', speaker: 'Bob', text: 'Hey Alice', ts: 4000 });
  st.apply({ key: 'b1', removed: true, ts: 5000 });
  const segs = st.sorted();
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((s) => [s.speaker, s.text]), [['Alice', 'Hi everyone'], ['Bob', 'Hey Alice']]);
  assert.equal(segs[0].final, true);
  assert.equal(segs[1].final, false);
  assert.match(st.toText(), /^\[00:00:01\] Alice: Hi everyone\n\[00:00:03\] Bob: Hey Alice$/);
});

test('store: re-created caption element does not duplicate text', () => {
  const st = new TranscriptStore({ origin: 0 });
  st.apply({ key: 'b1', speaker: 'Alice', text: 'Let us review the quarterly numbers', ts: 1000 });
  st.apply({ key: 'b1', removed: true, ts: 1500 });
  st.apply({ key: 'b9', speaker: 'Alice', text: 'Let us review the quarterly numbers now please', ts: 2000 });
  assert.equal(st.sorted().length, 1);
  assert.equal(st.sorted()[0].text, 'Let us review the quarterly numbers now please');
});

test('store: a repeated short reply after someone else is kept', () => {
  const st = new TranscriptStore({ origin: 0 });
  st.apply({ key: 'b1', speaker: 'Alice', text: 'Yes', ts: 1000 });
  st.apply({ key: 'b2', speaker: 'Bob', text: 'Are you sure about the date?', ts: 2000 });
  st.apply({ key: 'b1', removed: true, ts: 2500 });
  st.apply({ key: 'b3', speaker: 'Alice', text: 'Yes', ts: 3000 });
  assert.deepEqual(st.sorted().map((s) => `${s.speaker}: ${s.text}`), [
    'Alice: Yes',
    'Bob: Are you sure about the date?',
    'Alice: Yes',
  ]);
});

test('store: same speaker saying "Yes" twice in a row is kept twice', () => {
  const st = new TranscriptStore({ origin: 0 });
  st.apply({ key: 'b1', speaker: 'Alice', text: 'Yes', ts: 1000 });
  st.apply({ key: 'b1', removed: true, ts: 1500 });
  st.apply({ key: 'b2', speaker: 'Alice', text: 'Yes', ts: 2000 });
  assert.equal(st.sorted().length, 2);
});

test('store: speaker change on the same block starts a new segment', () => {
  const st = new TranscriptStore({ origin: 0 });
  st.apply({ key: 'b1', speaker: 'Alice', text: 'One', ts: 1000 });
  st.apply({ key: 'b1', speaker: 'Bob', text: 'Two', ts: 2000 });
  assert.deepEqual(st.sorted().map((s) => s.speaker), ['Alice', 'Bob']);
});

test('store: stats share adds up', () => {
  const st = new TranscriptStore({ origin: 0 });
  st.apply({ key: 'a', speaker: 'Alice', text: 'one two three', ts: 1000 });
  st.apply({ key: 'b', speaker: 'Bob', text: 'four', ts: 2000 });
  const stats = st.stats();
  assert.equal(stats[0].speaker, 'Alice');
  assert.equal(stats[0].share + stats[1].share, 100);
});
