import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Where the app's code lives (public/, node_modules/). Read-only inside the desktop app.
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Where settings (.env) and data live. The desktop app sets MEETING_AGENT_HOME to its own folder
// (%APPDATA%\Meeting Agent); from the command line it is the project folder, as before.
const HOME = process.env.MEETING_AGENT_HOME?.trim();
export const DATA_HOME = HOME ? path.resolve(HOME) : ROOT_DIR;
export const ENV_FILE = HOME ? path.join(DATA_HOME, '.env') : path.resolve(process.cwd(), '.env');
dotenv.config({ path: ENV_FILE });

const str = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
};
const num = (name, fallback) => {
  const v = Number(str(name, ''));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const bool = (name, fallback) => {
  const v = str(name, '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
};
const dir = (name, fallback) => path.resolve(DATA_HOME, str(name, fallback));

export const config = {
  botName: str('BOT_NAME', 'Meeting Notetaker'),
  browserChannel: str('BROWSER_CHANNEL', 'chrome'),
  headless: bool('HEADLESS', false),
  profileDir: dir('PROFILE_DIR', './.bot-profile'),
  admitTimeoutMs: num('ADMIT_TIMEOUT_MINUTES', 15) * 60_000,
  aloneTimeoutMs: num('ALONE_TIMEOUT_MINUTES', 3) * 60_000,
  maxMeetingMs: num('MAX_MEETING_MINUTES', 240) * 60_000,
  recordAudio: bool('RECORD_AUDIO', true),
  // Language the bot selects for Meet's captions, as Meet names it (e.g. "Albanian"). Empty = leave Meet's default.
  captionLanguage: str('CAPTION_LANGUAGE', ''),
  // Language the notes are written in. Empty = same language as the meeting.
  notesLanguage: str('NOTES_LANGUAGE', ''),

  anthropicConfigured: Boolean(str('ANTHROPIC_API_KEY', '') || str('ANTHROPIC_AUTH_TOKEN', '')),
  notesModel: str('NOTES_MODEL', 'claude-opus-5-5'),

  // Audio transcription after the meeting: "soniox", "deepgram", "none", or empty = first one with a key.
  transcriptionProvider: str('TRANSCRIPTION_PROVIDER', '').toLowerCase(),
  // Language code of the speech, e.g. "sq" for Albanian. Empty = let the service detect it.
  transcriptionLanguage: str('TRANSCRIPTION_LANGUAGE', str('DEEPGRAM_LANGUAGE', '')),
  sonioxKey: str('SONIOX_API_KEY', ''),
  sonioxModel: str('SONIOX_MODEL', 'stt-async-v6'),
  deepgramKey: str('DEEPGRAM_API_KEY', ''),

  port: num('PORT', 3000),
  dataDir: dir('DATA_DIR', './data/meetings'),
  assetsDir: path.join(DATA_HOME, '.assets'),
};
