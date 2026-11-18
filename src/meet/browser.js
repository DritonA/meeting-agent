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

  const channel = config.browserChannel && config.browserChannel !== 'chromium' ? config.browserChannel : undefined;
  try {
    return await chromium.launchPersistentContext(config.profileDir, { ...options, channel });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/ProcessSingleton|profile.*in use|user data directory is already in use|lock/i.test(msg)) {
      throw new Error(
        `The bot profile (${config.profileDir}) is already in use. Close the other bot or Chrome window using it and try again.`,
      );
    }
    if (!channel) throw err;
    log(`Could not start ${channel} (${msg.split('\n')[0]}). Falling back to Playwright Chromium.`);
    try {
      return await chromium.launchPersistentContext(config.profileDir, options);
    } catch (err2) {
      if (/Executable doesn't exist/i.test(String(err2?.message))) {
        throw new Error('No browser available. Install Google Chrome, or run: npx playwright install chromium');
      }
      throw err2;
    }
  }
}
