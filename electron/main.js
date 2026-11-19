// Desktop app (Windows): runs the same web server inside the app and shows the UI in its own window.
// Settings, the bot's Google profile and all meetings live in %APPDATA%\Meeting Agent, so the app
// works the same on any PC without a terminal or a project folder.
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'Meeting Agent';

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
if (process.platform === 'win32') app.setAppUserModelId('com.meetingagent.desktop');

const HOME = app.getPath('userData');
process.env.MEETING_AGENT_HOME = HOME;

// First run: create the settings file from the template, so there is something to fill in.
fs.mkdirSync(HOME, { recursive: true });
const envFile = path.join(HOME, '.env');
const firstRun = !fs.existsSync(envFile);
if (firstRun) fs.copyFileSync(path.join(APP_DIR, '.env.example'), envFile);

let win = null;
let quitting = false; // set once it is safe to close (nothing left to save)
let registry, config, openSignInWindow;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(main).catch((err) => {
    dialog.showErrorBox(APP_NAME, `Could not start: ${err.stack || err.message}`);
    app.exit(1);
  });
}

async function main() {
  // Imported only now: config.js reads MEETING_AGENT_HOME when it loads.
  ({ config } = await import('../src/config.js'));
  const server = await import('../src/server.js');
  ({ openSignInWindow } = await import('../src/login.js'));
  registry = server.registry;

  // Use the configured port; if it is taken (e.g. the web version is running), any free port.
  let port;
  try {
    port = await server.startServer(config.port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    port = await server.startServer(0);
  }
  const appUrl = `http://127.0.0.1:${port}`;

  Menu.setApplicationMenu(buildMenu());
  win = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 800,
    minHeight: 560,
    title: APP_NAME,
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Links to other sites (e.g. a Meet link) open in the normal browser, not inside the app.
  const isAppUrl = (url) => url.startsWith(`${appUrl}/`) || url === appUrl;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isAppUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    confirmQuit();
  });
  win.on('closed', () => (win = null));

  await win.loadURL(appUrl);
  watchSettings();
  if (firstRun || !config.anthropicConfigured) promptForSettings(firstRun);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting || !registry) return;
  event.preventDefault();
  confirmQuit();
});

/** Meetings that still need the app running: the bot is in a call, or notes are being written. */
function busySessions() {
  if (!registry) return [];
  return [...registry.sessions.values()].filter((s) =>
    ['starting', 'joining', 'waiting_admission', 'in_meeting', 'leaving', 'processing'].includes(s.meta.status),
  );
}

let confirming = false;
async function confirmQuit({ relaunch = false } = {}) {
  if (confirming) return;
  const busy = busySessions();
  if (!busy.length) return quitNow(relaunch);
  confirming = true;
  try {
    const inCall = Boolean(registry.activeBot());
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [inCall ? 'Leave meeting and close' : 'Finish and close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: APP_NAME,
      message: inCall ? 'The bot is still in a meeting.' : 'Meeting notes are still being written.',
      detail: inCall
        ? 'The bot will leave the call, save the transcript and write the notes, then the app closes.'
        : 'The app will close as soon as the notes are saved.',
    });
    if (response !== 0) return;
    win?.setTitle(`${APP_NAME} — saving, closing soon…`);
    for (const s of busy) s.stop();
    await Promise.allSettled(busy.map((s) => s.done));
    quitNow(relaunch);
  } finally {
    confirming = false;
  }
}

function quitNow(relaunch) {
  quitting = true;
  if (relaunch) app.relaunch();
  app.quit();
}

function openSettings() {
  // .env files have no default program on Windows, so open it in Notepad there.
  if (process.platform === 'win32') spawn('notepad.exe', [envFile], { detached: true, stdio: 'ignore' }).unref();
  else shell.openPath(envFile);
}

async function promptForSettings(isFirstRun) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Open settings', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: APP_NAME,
    message: isFirstRun ? `Welcome to ${APP_NAME}` : 'AI notes are not set up yet',
    detail:
      'To get AI meeting notes, put your Anthropic API key after ANTHROPIC_API_KEY= in the settings file, ' +
      'then save it. Transcripts and recordings work without it.\n\n' +
      'Settings are opened from the File menu at any time.',
  });
  if (response === 0) openSettings();
}

// Settings are read at start-up, so offer a restart when the file is saved.
function watchSettings() {
  let timer = null;
  let asking = false;
  let last = fs.readFileSync(envFile, 'utf8');
  fs.watchFile(envFile, { interval: 1500 }, async () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      let now;
      try {
        now = fs.readFileSync(envFile, 'utf8');
      } catch {
        return;
      }
      if (now === last || asking || !win) return;
      last = now;
      asking = true;
      const busy = busySessions().length > 0;
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: busy ? ['OK'] : ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: busy ? 0 : 1,
        title: APP_NAME,
        message: 'Settings saved.',
        detail: busy
          ? 'They apply the next time the app starts. Restart it from the File menu after the meeting.'
          : 'Restart the app to use the new settings.',
      });
      asking = false;
      if (!busy && response === 0) confirmQuit({ relaunch: true });
    }, 500);
  });
}

async function signInBot() {
  if (registry.activeBot()) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: APP_NAME,
      message: 'The bot is in a meeting right now.',
      detail: 'Sign in after the meeting; the sign-in uses the same browser profile as the bot.',
    });
    return;
  }
  await dialog.showMessageBox(win, {
    type: 'info',
    title: APP_NAME,
    message: "Sign the bot into a Google account",
    detail:
      "A browser window opens on the bot's own profile (separate from your personal browser). " +
      'Sign in to the account the bot should join meetings as, then close that window.\n\n' +
      'Tip: use a dedicated account (e.g. notetaker@yourcompany.com).',
  });
  try {
    await openSignInWindow({ log: () => {} });
  } catch (err) {
    dialog.showErrorBox(APP_NAME, `Could not open the sign-in window: ${err.message}`);
  }
}

function buildMenu() {
  const openFolder = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  };
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open meetings folder', click: () => openFolder(config.dataDir) },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { label: 'Restart', click: () => confirmQuit({ relaunch: true }) },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => confirmQuit() },
      ],
    },
    {
      label: 'Bot',
      submenu: [
        { label: 'Sign in to Google account…', click: signInBot },
        { label: 'Open app data folder', click: () => openFolder(HOME) },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]);
}
