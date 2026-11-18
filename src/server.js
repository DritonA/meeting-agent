import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, ROOT_DIR } from './config.js';
import { Registry } from './registry.js';
import { fileType } from './session.js';
import { availableProviders, defaultProvider } from './stt/index.js';

const registry = new Registry();
const app = express();

// This app is for this computer only. Reject other host names (blocks DNS-rebinding tricks), and
// require a custom header on API calls that change something, which other websites open in your
// browser cannot send without permission.
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).send('Forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-meeting-agent'] !== '1') {
    return res.status(403).json({ error: 'Missing X-Meeting-Agent header' });
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.get('/vendor/marked.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(ROOT_DIR, 'node_modules/marked/lib/marked.esm.js'));
});
app.get('/vendor/purify.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(ROOT_DIR, 'node_modules/dompurify/dist/purify.es.mjs'));
});

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

const sessionOr404 = (req, res) => {
  const s = registry.get(req.params.id);
  if (!s) res.status(404).json({ error: 'Meeting not found' });
  return s;
};

app.get('/api/config', (_req, res) => {
  res.json({
    botName: config.botName,
    notesModel: config.notesModel,
    notesConfigured: config.anthropicConfigured,
    transcriptionProviders: availableProviders(),
    defaultTranscriptionProvider: defaultProvider(),
    recordAudio: config.recordAudio,
  });
});

app.get('/api/meetings', (_req, res) => res.json(registry.list()));

app.post(
  '/api/meetings',
  handle((req, res) => {
    const { url, botName, title } = req.body || {};
    if (!url) throw new Error('Paste a Google Meet link.');
    const s = registry.start({ url, botName, title });
    res.status(201).json(s.summary());
  }),
);

app.get('/api/meetings/:id', (req, res) => {
  const s = sessionOr404(req, res);
  if (s) res.json(s.snapshot());
});

app.post('/api/meetings/:id/stop', (req, res) => {
  const s = sessionOr404(req, res);
  if (!s) return;
  s.stop();
  res.json(s.summary());
});

app.post(
  '/api/meetings/:id/notes',
  handle(async (req, res) => {
    const s = sessionOr404(req, res);
    if (!s) return;
    s.regenerateNotes().catch((err) => s.log(`Notes job failed: ${err.message}`));
    res.status(202).json({ ok: true });
  }),
);

// Transcribe the recorded audio again, e.g. with a different provider (soniox / deepgram).
app.post(
  '/api/meetings/:id/audio-transcript',
  handle(async (req, res) => {
    const s = sessionOr404(req, res);
    if (!s) return;
    const provider = (req.body?.provider || defaultProvider() || '').toLowerCase();
    if (!provider) throw new Error('No transcription service configured. Set SONIOX_API_KEY or DEEPGRAM_API_KEY in .env.');
    s.retranscribeAudio(provider).catch((err) => s.log(`Audio transcription job failed: ${err.message}`));
    res.status(202).json({ ok: true });
  }),
);

// Live updates (Server-Sent Events)
app.get('/api/meetings/:id/events', (req, res) => {
  const s = sessionOr404(req, res);
  if (!s) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send('snapshot', s.snapshot());
  const onUpdate = ({ type, data }) => send(type, data);
  s.on('update', onUpdate);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    s.off('update', onUpdate);
  });
});

app.get('/api/meetings/:id/files/:name', (req, res) => {
  const s = sessionOr404(req, res);
  if (!s) return;
  const { name } = req.params;
  const type = fileType(name);
  if (!type) return res.status(404).json({ error: 'Unknown file' });
  const file = s.file(name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not available yet' });
  res.type(type);
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.query.download) res.attachment(`${s.meta.id}_${name}`);
  res.sendFile(file);
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`\nMeeting Agent is running: http://localhost:${config.port}\n`);
  console.log(`Meetings are saved in ${config.dataDir}`);
  if (!config.anthropicConfigured) console.log('Note: ANTHROPIC_API_KEY is not set; AI notes will be skipped (transcripts still work).');
});

let shuttingDown = false;
process.on('SIGINT', async () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  const active = registry.activeBot();
  if (!active) process.exit(0);
  console.log('\nLeaving the meeting and saving everything (press Ctrl+C again to force quit)...');
  active.stop();
  await active.done;
  process.exit(0);
});
