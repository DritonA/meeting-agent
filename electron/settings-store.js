// Desktop settings: kept in %APPDATA%\Meeting Agent\settings.json.
// API keys are encrypted with Electron safeStorage (Windows DPAPI): only the same Windows user on the
// same PC can decrypt them. Decrypted keys stay in this (main) process. The settings window only
// learns whether a key is set and its last 4 characters, and keys never go into process.env,
// so child processes such as the bot's Chrome don't inherit them.
import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];

// Every setting the desktop app manages, by its .env name. `restart`: only applied on the next start.
export const FIELDS = [
  { key: 'ANTHROPIC_API_KEY', group: 'notes', type: 'secret', label: 'Anthropic API key',
    help: 'Needed for AI meeting notes. Without it you still get the transcript and recording.' },
  { key: 'NOTES_MODEL', group: 'notes', type: 'select', label: 'Model', options: MODELS, default: 'claude-opus-5-5' },
  { key: 'NOTES_LANGUAGE', group: 'notes', type: 'text', label: 'Notes language',
    placeholder: 'Same as the meeting', help: 'For example Albanian or English.' },

  { key: 'BOT_NAME', group: 'bot', type: 'text', label: 'Bot name', default: 'Meeting Notetaker',
    help: 'Shown to other participants when the bot joins as a guest.' },
  { key: 'CAPTION_LANGUAGE', group: 'bot', type: 'text', label: 'Caption language', placeholder: "Meet's default (English)",
    help: 'As Meet names it, e.g. Albanian. Must match what people speak, or captions come out as nonsense.' },
  { key: 'BROWSER_CHANNEL', group: 'bot', type: 'select', label: 'Browser', default: 'chrome',
    options: [
      { value: 'chrome', label: 'Google Chrome (Microsoft Edge if Chrome is missing)' },
      { value: 'msedge', label: 'Microsoft Edge' },
      { value: 'chromium', label: 'Playwright Chromium' },
    ] },
  { key: 'RECORD_AUDIO', group: 'bot', type: 'bool', label: 'Record audio', default: 'true',
    help: 'Saves the meeting audio as a backup and for audio transcription.' },

  { key: 'TRANSCRIPTION_PROVIDER', group: 'stt', type: 'select', label: 'Service', default: '',
    options: [
      { value: '', label: 'Automatic (first one with a key)' },
      { value: 'soniox', label: 'Soniox' },
      { value: 'deepgram', label: 'Deepgram' },
      { value: 'none', label: 'Off' },
    ] },
  { key: 'TRANSCRIPTION_LANGUAGE', group: 'stt', type: 'text', label: 'Speech language code',
    placeholder: 'Detect automatically', help: 'For example sq for Albanian.' },
  { key: 'SONIOX_API_KEY', group: 'stt', type: 'secret', label: 'Soniox API key' },
  { key: 'DEEPGRAM_API_KEY', group: 'stt', type: 'secret', label: 'Deepgram API key' },

  { key: 'ADMIT_TIMEOUT_MINUTES', group: 'advanced', type: 'number', label: 'Wait to be admitted (minutes)', default: '15', min: 1, max: 240 },
  { key: 'ALONE_TIMEOUT_MINUTES', group: 'advanced', type: 'number', label: 'Leave when alone after (minutes)', default: '3', min: 1, max: 240 },
  { key: 'MAX_MEETING_MINUTES', group: 'advanced', type: 'number', label: 'Longest meeting (minutes)', default: '240', min: 1, max: 1440 },
  { key: 'HEADLESS', group: 'advanced', type: 'bool', label: 'Hide bot window', default: 'false',
    help: "Runs the bot's browser invisibly. Less reliable with Google Meet." },
  { key: 'SONIOX_MODEL', group: 'advanced', type: 'text', label: 'Soniox model', default: 'stt-async-v6' },
  { key: 'DATA_DIR', group: 'advanced', type: 'folder', label: 'Meetings folder', default: './data/meetings', restart: true,
    help: 'Where transcripts, notes and recordings are saved. Meetings already saved stay in the old folder.' },
  { key: 'PORT', group: 'advanced', type: 'number', label: 'Local port', default: '3000', min: 1024, max: 65535, restart: true },
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
const optionValues = (f) => f.options.map((o) => (typeof o === 'string' ? o : o.value));

export class SettingsStore {
  constructor(home, templateFile) {
    this.home = home;
    this.file = path.join(home, 'settings.json');
    this.values = {}; // non-secret settings, by key
    this.secrets = {}; // key -> base64 of the safeStorage-encrypted value (what is on disk)
    this.plain = {}; // key -> decrypted value, filled by init(); never leaves the main process
    this.canEncrypt = false;
    this.isNew = !fs.existsSync(this.file);
    if (this.isNew) this.values = this.#defaultsFrom(templateFile);
    else this.#read();
  }

  /** Call once the app is ready: checks the OS key store and decrypts the saved keys. */
  async init() {
    this.canEncrypt = await safeStorage.isAsyncEncryptionAvailable();
    if (!this.canEncrypt) return;
    let reEncrypted = false;
    for (const [key, enc] of Object.entries(this.secrets)) {
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'));
        this.plain[key] = result;
        // Windows rotated the key or offers a stronger one: store the key encrypted the new way.
        if (shouldReEncrypt) {
          this.secrets[key] = (await safeStorage.encryptStringAsync(result)).toString('base64');
          reEncrypted = true;
        }
      } catch {
        // e.g. the file was copied from another PC or Windows user: treat the key as not set
      }
    }
    if (reEncrypted) this.#write();
  }

  #read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(data.values || {})) if (BY_KEY.get(k) && BY_KEY.get(k).type !== 'secret') this.values[k] = String(v);
      for (const [k, v] of Object.entries(data.secrets || {})) if (BY_KEY.get(k)?.type === 'secret') this.secrets[k] = String(v);
    } catch (err) {
      throw new Error(`Could not read ${this.file}: ${err.message}`);
    }
  }

  // First start: take the non-secret starting values from .env.example (e.g. the caption language).
  #defaultsFrom(templateFile) {
    const out = {};
    try {
      for (const line of fs.readFileSync(templateFile, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        const f = m && BY_KEY.get(m[1]);
        if (f && f.type !== 'secret' && m[2] !== '') out[f.key] = m[2];
      }
    } catch {
      // no template: built-in defaults
    }
    return out;
  }

  #write() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, values: this.values, secrets: this.secrets }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.isNew = false;
  }

  #decrypt(key) {
    return this.plain[key] || '';
  }

  /** All settings with secrets decrypted, for the app itself (config.applySettings). Main process only. */
  resolved() {
    const out = {};
    for (const f of FIELDS) out[f.key] = f.type === 'secret' ? this.#decrypt(f.key) : (this.values[f.key] ?? f.default ?? '');
    return out;
  }

  /** What the settings window may see: values, but for secrets only whether set and the last 4 characters. */
  forDisplay() {
    const values = {};
    const secrets = {};
    for (const f of FIELDS) {
      if (f.type === 'secret') {
        const v = this.#decrypt(f.key);
        secrets[f.key] = v ? { set: true, hint: v.length > 8 ? v.slice(-4) : '' } : { set: false, unreadable: Boolean(this.secrets[f.key]) };
      } else {
        values[f.key] = this.values[f.key] ?? f.default ?? '';
        if (f.type === 'folder') values[f.key] = path.resolve(this.home, values[f.key]);
      }
    }
    // Show folders as full paths, including the default.
    const fields = FIELDS.map((f) => (f.type === 'folder' ? { ...f, default: path.resolve(this.home, f.default) } : f));
    return { fields, values, secrets, canEncrypt: this.canEncrypt };
  }

  /**
   * Save changes from the settings window. `values`: non-secret settings to set.
   * `secrets`: { KEY: 'new value' } to replace a key, { KEY: null } to remove it; keys left out are kept.
   * Returns the keys whose change only applies after a restart.
   */
  async update({ values = {}, secrets = {} } = {}) {
    const nextValues = { ...this.values };
    const nextSecrets = { ...this.secrets };
    const nextPlain = { ...this.plain };
    const changed = [];

    for (const [key, raw] of Object.entries(values)) {
      const f = BY_KEY.get(key);
      if (!f || f.type === 'secret') throw new Error(`Unknown setting: ${key}`);
      const v = validate(f, raw, this.home);
      if ((nextValues[key] ?? f.default ?? '') !== v) changed.push(key);
      nextValues[key] = v;
    }
    for (const [key, raw] of Object.entries(secrets)) {
      const f = BY_KEY.get(key);
      if (f?.type !== 'secret') throw new Error(`Unknown key: ${key}`);
      if (raw === null) {
        delete nextSecrets[key];
        delete nextPlain[key];
        continue;
      }
      const v = String(raw).trim();
      if (!v) continue;
      if (v.length > 500 || /\s/.test(v)) throw new Error(`${f.label}: that doesn't look like a key (no spaces allowed).`);
      if (!this.canEncrypt) throw new Error('Windows secure storage is not available, so keys cannot be saved safely.');
      nextSecrets[key] = (await safeStorage.encryptStringAsync(v)).toString('base64');
      nextPlain[key] = v;
    }

    this.values = nextValues;
    this.secrets = nextSecrets;
    this.plain = nextPlain;
    this.#write();
    return changed.filter((k) => BY_KEY.get(k).restart);
  }
}

function validate(f, raw, home) {
  const v = String(raw ?? '').trim();
  if (v.length > 300 || /[\r\n\0]/.test(v)) throw new Error(`${f.label}: value is too long or has line breaks.`);
  switch (f.type) {
    case 'bool':
      if (!['true', 'false'].includes(v)) throw new Error(`${f.label}: expected on or off.`);
      return v;
    case 'number': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(`${f.label}: enter a whole number from ${f.min} to ${f.max}.`);
      return String(n);
    }
    case 'select':
      // Keep a custom value already in use (e.g. another model name) even if it isn't in the list.
      if (!optionValues(f).includes(v) && !(f.key === 'NOTES_MODEL' && /^[a-z0-9.-]+$/i.test(v))) {
        throw new Error(`${f.label}: unknown choice "${v}".`);
      }
      return v;
    case 'folder':
      // The default folder is stored as-is (relative to the app's data folder), so it never looks changed.
      if (!v || path.resolve(home, v) === path.resolve(home, f.default)) return f.default;
      if (!path.isAbsolute(v)) throw new Error(`${f.label}: choose a folder with Browse.`);
      return path.normalize(v);
    default:
      return v;
  }
}
