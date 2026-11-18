#!/usr/bin/env node
// Opens Chrome with the bot's own profile so you can sign the bot into a Google account once.
// Afterwards the bot joins meetings as that account (needed for meetings that block guests).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/';

function findChrome() {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => p && fs.existsSync(p));
}

fs.mkdirSync(config.profileDir, { recursive: true });
console.log(`Bot profile: ${config.profileDir}`);
console.log('A Chrome window will open. Sign in to the Google account the bot should use, then close the window.');
console.log('Tip: use a dedicated account (e.g. notetaker@yourcompany.com) rather than your personal one.\n');

const chrome = findChrome();
if (chrome) {
  // Launch Chrome directly (not under automation) so Google accepts the sign-in.
  const child = spawn(chrome, [`--user-data-dir=${config.profileDir}`, '--no-first-run', '--no-default-browser-check', SIGN_IN_URL], {
    stdio: 'ignore',
  });
  child.on('exit', () => {
    console.log('Chrome closed. The bot will now join meetings as the signed-in account.');
    process.exit(0);
  });
} else {
  console.log('Google Chrome not found; using Playwright Chromium instead.');
  const { launchBotBrowser } = await import('./meet/browser.js');
  const ctx = await launchBotBrowser();
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(SIGN_IN_URL);
  ctx.on('close', () => {
    console.log('Browser closed. Sign-in saved.');
    process.exit(0);
  });
}
