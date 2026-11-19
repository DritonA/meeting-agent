#!/usr/bin/env node
// Opens Chrome with the bot's own profile so you can sign the bot into a Google account once.
// Afterwards the bot joins meetings as that account (needed for meetings that block guests).
// Run from the terminal with `npm run login`, or from the desktop app's Bot menu.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';

const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/';

function findChrome() {
  const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(pf, 'Google/Chrome/Application/chrome.exe'),
          path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
          // The bot falls back to Edge when Chrome is missing, so sign in with Edge in that case too.
          ...(config.browserChannel === 'chrome'
            ? [path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf, 'Microsoft/Edge/Application/msedge.exe')]
            : []),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => p && fs.existsSync(p));
}

/** Open a browser window on the bot's profile for signing in. Resolves when the window is closed. */
export async function openSignInWindow({ log = console.log } = {}) {
  fs.mkdirSync(config.profileDir, { recursive: true });
  const chrome = findChrome();
  if (chrome) {
    // Launch the browser directly (not under automation) so Google accepts the sign-in.
    const child = spawn(chrome, [`--user-data-dir=${config.profileDir}`, '--no-first-run', '--no-default-browser-check', SIGN_IN_URL], {
      stdio: 'ignore',
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return;
  }
  log('Google Chrome not found; using Playwright Chromium instead.');
  const { launchBotBrowser } = await import('./meet/browser.js');
  const ctx = await launchBotBrowser({ log });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(SIGN_IN_URL);
  await new Promise((resolve) => ctx.once('close', resolve));
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  console.log(`Bot profile: ${config.profileDir}`);
  console.log('A Chrome window will open. Sign in to the Google account the bot should use, then close the window.');
  console.log('Tip: use a dedicated account (e.g. notetaker@yourcompany.com) rather than your personal one.\n');
  try {
    await openSignInWindow();
    console.log('Browser closed. The bot will now join meetings as the signed-in account.');
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
