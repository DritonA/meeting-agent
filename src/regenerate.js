#!/usr/bin/env node
// Re-create notes.md for a saved meeting:  npm run notes -- <meeting-folder-name or path>
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { MeetingSession } from './session.js';

const arg = process.argv[2];
if (!arg) {
  const all = fs.existsSync(config.dataDir) ? fs.readdirSync(config.dataDir) : [];
  console.log('Usage: npm run notes -- <meeting folder>\n\nSaved meetings:');
  for (const name of all) console.log(`  ${name}`);
  process.exit(1);
}
const dir = fs.existsSync(arg) ? path.resolve(arg) : path.join(config.dataDir, arg);
if (!fs.existsSync(path.join(dir, 'meta.json'))) {
  console.error(`No meeting found at ${dir}`);
  process.exit(1);
}
const session = MeetingSession.load(dir);
console.log(`Generating notes for "${session.meta.title}"...`);
await session.regenerateNotes();
if (session.meta.notesError) console.log(`Problem: ${session.meta.notesError}`);
console.log(`Notes: ${session.file('notes.md')}`);
