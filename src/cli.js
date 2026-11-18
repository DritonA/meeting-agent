#!/usr/bin/env node
// Join a meeting from the terminal without the web UI:
//   npm run join -- https://meet.google.com/abc-defg-hij --name "Notetaker" --title "Weekly sync"
import { MeetingSession } from './session.js';
import { formatOffset } from './transcript/store.js';

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = args.find((a, i) => !a.startsWith('--') && !['--name', '--title'].includes(args[i - 1]));
if (!url) {
  console.log('Usage: npm run join -- <google-meet-url> [--name "Bot name"] [--title "Meeting title"]');
  process.exit(1);
}

let session;
try {
  session = MeetingSession.create({ url, botName: opt('--name'), title: opt('--title') });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(`Saving to ${session.dir}`);
session.on('update', ({ type, data }) => {
  if (type === 'meta') return;
  if (type === 'log') console.log(`  · ${data.msg}`);
});
session.on('final-segment', (seg) => {
  console.log(`[${formatOffset(seg.start - session.store.origin0)}] ${seg.speaker}: ${seg.text}`);
});

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\nLeaving the meeting and writing notes (Ctrl+C again to force quit)...');
  session.stop();
});

await session.start();
const m = session.meta;
console.log(`\nFinished: ${m.status}${m.statusDetail ? ` — ${m.statusDetail}` : ''}`);
if (m.notesError) console.log(`Notes: ${m.notesError}`);
console.log('Files:');
for (const f of session.availableFiles()) console.log(`  ${session.file(f)}`);
process.exit(m.status === 'failed' ? 1 : 0);
