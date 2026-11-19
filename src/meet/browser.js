import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { ensureFakeMedia } from './fakeMedia.js';

/** Launch Chrome with the bot's persistent profile, set up for joining Meet. */
export async function launchBotBrowser({ log = () => {} } = {}) {
  fs.mkdirSync(config.profileDir, { recursive: true });
  const media = ensureFakeMedia(config.assetsDir);
  const options = {
    headless: config.headless,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    permissions: ['microphone', 'camera'],
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${media.wav}`,
      `--use-file-for-fake-video-capture=${media.y4m}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=en-US',
      '--window-size=1300,900',
    ],
  };

  // Browsers to try in order. Microsoft Edge is on every Windows PC, so it backs up Chrome there.
  const channel = config.browserChannel && config.browserChannel !== 'chromium' ? config.browserChannel : undefined;
  const channels = [channel];
  if (channel === 'chrome' && process.platform === 'win32') channels.push('msedge');
  if (channel) channels.push(undefined); // Playwright's own Chromium

  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    try {
      return await chromium.launchPersistentContext(config.profileDir, { ...options, channel: ch });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/ProcessSingleton|profile.*in use|user data directory is already in use|lock/i.test(msg)) {
        throw new Error(
          `The bot profile (${config.profileDir}) is already in use. Close the other bot or Chrome window using it and try again.`,
        );
      }
      const next = channels[i + 1];
      if (i === channels.length - 1) {
        if (/Executable doesn't exist/i.test(msg)) {
          throw new Error('No browser available. Install Google Chrome, or run: npx playwright install chromium');
        }
        throw err;
      }
      log(`Could not start ${ch || 'Chromium'} (${msg.split('\n')[0]}). Trying ${next || 'Playwright Chromium'} instead.`);
    }
  }
}
