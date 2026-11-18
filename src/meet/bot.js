import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { launchBotBrowser } from './browser.js';
import { SELECTORS, PAGE_TEXT } from './selectors.js';
import {
  rtcHookInitScript,
  startAudioRecorder,
  startCaptionObserver,
  readParticipants,
  captionsState,
  recorderHealth,
  captionDebugInfo,
} from './inpage.js';
import fs from 'node:fs';
import path from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = (loc) => loc.first().isVisible().catch(() => false);
const withTimeout = (promise, ms) => Promise.race([promise, wait(ms)]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const JOIN_BUTTON = /^(join now|ask to join|join anyway|join here too|join)$/i;

export class BotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function normalizeMeetUrl(input) {
  let s = String(input || '').trim();
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(s)) s = `https://meet.google.com/${s}`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.hostname !== 'meet.google.com') throw new Error('Please paste a Google Meet link (https://meet.google.com/...)');
  if (u.pathname.replace(/\//g, '').length < 3) throw new Error('That Meet link has no meeting code.');
  return `${u.origin}${u.pathname}${u.search}`;
}

export function meetingCode(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() || 'meeting';
  } catch {
    return 'meeting';
  }
}

/**
 * Joins one Google Meet call and streams what happens in it.
 * Events: status(status, detail), log(msg), caption(snapshot), audio(recorderId, Buffer),
 *         participants({count, names}), joined(ts), recording({id, startedAt, restarted}),
 *         health({captionsOn, recorder})
 */
export class MeetBot extends EventEmitter {
  constructor({ url, botName, screenshotPath }) {
    super();
    this.url = url;
    this.botName = botName || config.botName;
    this.screenshotPath = screenshotPath;
    this.stopRequested = null;
    this.captionKeyPresses = 0;
    this.rejoins = 0;
    this.captionEvents = 0;
    this.debugDumps = 0;
  }

  stop(reason = 'Stopped by user') {
    if (!this.stopRequested) this.stopRequested = reason;
  }

  status(status, detail) {
    this.emit('status', status, detail);
  }

  log(msg) {
    this.emit('log', msg);
  }

  async run() {
    const result = { joinedAt: null, endedAt: null, recordingStartedAt: null, reason: null, error: null, code: null };
    let context;
    let page;
    try {
      this.status('starting', 'Launching browser');
      context = await launchBotBrowser({ log: (m) => this.log(m) });
      await context.addInitScript(rtcHookInitScript);
      page = context.pages()[0] || (await context.newPage());
      for (const p of context.pages()) if (p !== page) await p.close().catch(() => {});
      await page.exposeFunction('__meetAgentCaption', (snap) => {
        if (!snap.removed) this.captionEvents += 1;
        this.emit('caption', snap);
      });
      await page.exposeFunction('__meetAgentAudio', (id, b64) => this.emit('audio', id, Buffer.from(b64, 'base64')));

      this.status('joining', 'Opening Google Meet');
      const u = new URL(this.url);
      u.searchParams.set('hl', 'en'); // force English UI so the bot can read buttons and messages
      await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });

      await this.join(page);
      result.joinedAt = Date.now();
      this.emit('joined', result.joinedAt);
      this.status('in_meeting', 'In the meeting, transcribing');

      await wait(1500);
      await this.dismissDialogs(page);
      if (!(await this.enableCaptions(page))) {
        this.log('Could not confirm captions are on yet; will keep trying.');
        await this.dumpCaptionDebug(page, 'Captions could not be turned on after joining');
      }
      await this.ensureCaptionLanguage(page);
      await page.evaluate(startCaptionObserver, SELECTORS);

      if (config.recordAudio) await this.ensureRecorder(page);

      result.reason = await this.monitor(page, result.joinedAt);
    } catch (err) {
      result.error = err.message;
      result.code = err.code || 'error';
      if (page && !page.isClosed() && this.screenshotPath) {
        await page.screenshot({ path: this.screenshotPath }).catch(() => {});
      }
    } finally {
      if (page && !page.isClosed() && result.joinedAt && this.captionEvents === 0) {
        await this.dumpCaptionDebug(page, 'No captions were received during the whole meeting');
      }
      if (page && !page.isClosed() && result.joinedAt) await this.leave(page);
      result.endedAt = Date.now();
      await context?.close().catch(() => {});
    }
    return result;
  }

  async inCall(page) {
    return visible(page.locator('[aria-label*="Leave call" i]'));
  }

  async bodyText(page) {
    return page.evaluate(() => document.body?.innerText || '').catch(() => '');
  }

  async dismissDialogs(page) {
    const candidates = [
      page.getByRole('button', { name: /continue without microphone and camera/i }),
      page.locator('[role="dialog"], [role="alertdialog"]').getByRole('button', {
        name: /^(got it|dismiss|close|ok|okay|no thanks|not now)$/i,
      }),
    ];
    for (const loc of candidates) {
      if (await visible(loc)) await loc.first().click({ timeout: 2000 }).catch(() => {});
    }
  }

  async join(page) {
    const startedAt = Date.now();
    const hardDeadline = startedAt + config.admitTimeoutMs + 3 * 60_000;
    let joinClicks = 0;
    let lastJoinClick = 0;
    let waitingSince = null;
    let sawJoinButton = false;

    while (Date.now() < hardDeadline) {
      if (this.stopRequested) throw new BotError('cancelled', this.stopRequested);
      if (page.isClosed()) throw new BotError('closed', 'The bot browser window was closed.');
      if (await this.inCall(page)) return;

      const text = await this.bodyText(page);
      if (PAGE_TEXT.blocked.test(text)) {
        throw new BotError(
          'blocked',
          "Google Meet didn't let the bot join (\"You can't join this video call\"). This usually means the meeting only " +
            'allows signed-in or same-organization users. Run `npm run login` to sign the bot into a Google account, or ' +
            'ask the host to allow guests.',
        );
      }
      if (PAGE_TEXT.denied.test(text)) throw new BotError('denied', 'The host declined the request to join.');
      if (PAGE_TEXT.removed.test(text)) throw new BotError('removed', 'The bot was removed from the meeting.');
      if (PAGE_TEXT.invalid.test(text)) throw new BotError('invalid', 'Google Meet says this meeting link is invalid.');

      await this.dismissDialogs(page);

      // Guest name
      const nameInput = page.locator('input[aria-label="Your name" i], input[placeholder="Your name" i]').first();
      if ((await visible(nameInput)) && !(await nameInput.inputValue().catch(() => 'x'))) {
        await nameInput.fill(this.botName).catch(() => {});
      }

      // Make sure the bot's mic and camera are off before joining.
      for (const label of ['Turn off microphone', 'Turn off camera']) {
        const btn = page.locator(`[aria-label*="${label}" i]`);
        if (await visible(btn)) {
          await btn.first().click({ timeout: 2000 }).catch(() => {});
          await wait(300);
        }
      }

      if (PAGE_TEXT.waiting.test(text)) {
        if (!waitingSince) {
          waitingSince = Date.now();
          this.status('waiting_admission', 'Waiting for someone in the meeting to let the bot in');
        }
        if (Date.now() - waitingSince > config.admitTimeoutMs) {
          throw new BotError('not_admitted', 'Nobody admitted the bot before the timeout.');
        }
      } else {
        const joinBtn = page.getByRole('button', { name: JOIN_BUTTON }).first();
        const canClick = await visible(joinBtn);
        if (canClick) sawJoinButton = true;
        const retry = PAGE_TEXT.noResponse.test(text) || Date.now() - lastJoinClick > 20_000;
        if (canClick && retry && joinClicks < 6 && (await joinBtn.isEnabled().catch(() => false))) {
          await joinBtn.click({ timeout: 5000 }).catch(() => {});
          joinClicks += 1;
          lastJoinClick = Date.now();
          waitingSince = null;
          this.status('joining', joinClicks > 1 ? 'Asking to join again' : 'Asking to join');
        }
      }

      if (!sawJoinButton && !waitingSince && Date.now() - startedAt > 90_000) {
        const hint = PAGE_TEXT.signIn.test(text)
          ? 'This meeting requires a signed-in Google account. Run `npm run login` once to sign the bot in.'
          : 'Could not find the "Join" button on the Meet page. See error.png in the meeting folder.';
        throw new BotError('stuck', hint);
      }
      await wait(1000);
    }
    throw new BotError('timeout', 'Timed out while trying to join the meeting.');
  }

  async captionsOn(page) {
    const st = await page.evaluate(captionsState, SELECTORS).catch(() => ({ on: false }));
    return st.on;
  }

  async waitForCaptions(page, ms = 4000) {
    for (let t = 0; t < ms; t += 500) {
      await wait(500);
      if (await this.captionsOn(page)) return true;
    }
    return false;
  }

  /** Turn Meet's captions on, trying several ways. Never toggles them off. */
  async enableCaptions(page) {
    if (await this.captionsOn(page)) return true;
    const tried = [];
    const done = (how) => {
      this.log(`Captions are on (${how}).`);
      return true;
    };

    // 1) Meet's "c" keyboard shortcut: works even when the toolbar is hidden (verified on real
    //    Meet, Nov 2026). Only once per meeting: we already checked captions are off, but a second
    //    press could turn them off if detection ever misses them.
    if (this.captionKeyPresses < 1) {
      tried.push('keyboard shortcut');
      this.captionKeyPresses += 1;
      // Move focus off any text field (e.g. chat) so the key is read as a shortcut.
      await page.evaluate(() => {
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      }).catch(() => {});
      await page.keyboard.press('c').catch(() => {});
      if (await this.waitForCaptions(page)) return done('keyboard shortcut');
    }

    // 2) The captions button in the call toolbar ("Captions and translation" since late 2026).
    //    The toolbar hides when the mouse is idle, so move the mouse to show it first.
    await page.mouse.move(640, 700).catch(() => {});
    await wait(400);
    const ccButton = page
      .locator('[aria-label*="Turn on captions" i], [aria-label*="Show captions" i]')
      .or(page.locator('button[aria-label*="caption" i][aria-pressed="false"]'));
    if (await visible(ccButton)) {
      tried.push('toolbar button');
      await ccButton.first().click({ timeout: 3000 }).catch(() => {});
      if (await this.waitForCaptions(page)) return done('toolbar button');
    }

    // 3) The "More options" (three dots) menu.
    const more = page.getByRole('button', { name: /more options/i });
    if (await visible(more)) {
      tried.push('more options menu');
      await more.first().click({ timeout: 3000 }).catch(() => {});
      await wait(600);
      const item = page.getByRole('menuitem', { name: /turn on captions|show captions|^captions/i })
        .or(page.getByRole('menuitemcheckbox', { name: /captions/i }));
      const itemName = (await item.first().textContent().catch(() => '')) || '';
      if ((await visible(item)) && !/turn off|hide/i.test(itemName)) {
        await item.first().click({ timeout: 3000 }).catch(() => {});
        if (await this.waitForCaptions(page)) return done('more options menu');
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    if (tried.length) this.log(`Could not turn captions on (tried: ${tried.join(', ')}).`);
    return false;
  }

  /** Save what the Meet page looks like when captions fail, so selectors can be fixed. */
  async dumpCaptionDebug(page, reason) {
    if (!this.screenshotPath || this.debugDumps >= 3) return;
    this.debugDumps += 1;
    const dir = path.dirname(this.screenshotPath);
    const base = path.join(dir, `captions-debug-${this.debugDumps}`);
    try {
      const info = await page.evaluate(captionDebugInfo);
      const state = await page.evaluate(captionsState, SELECTORS).catch(() => null);
      fs.writeFileSync(`${base}.json`, JSON.stringify({ reason, at: new Date().toISOString(), captionsState: state, ...info }, null, 2));
      await page.screenshot({ path: `${base}.png` }).catch(() => {});
      this.log(`Saved caption diagnostics (${path.basename(base)}.json/.png) for troubleshooting.`);
    } catch (err) {
      this.log(`Could not save caption diagnostics: ${err.message}`);
    }
  }

  /**
   * Make sure the audio recorder is running in the page; start a new one if it is missing
   * (first start, or Meet reloaded the page) or stopped. Returns the recorder's health.
   */
  async ensureRecorder(page) {
    let health = await page.evaluate(recorderHealth).catch(() => null);
    if (health && health.state !== 'inactive') return health;
    const restarted = Boolean(this.recorderStarted);
    try {
      const { id, startedAt } = await page.evaluate(startAudioRecorder);
      this.recorderStarted = true;
      this.emit('recording', { id, startedAt, restarted });
      health = await page.evaluate(recorderHealth).catch(() => null);
    } catch (err) {
      this.log(`Could not start the audio recorder: ${err.message}`);
    }
    return health;
  }

  /** Select config.captionLanguage (e.g. "Albanian") in Meet. Tries a few times over the meeting. */
  async ensureCaptionLanguage(page) {
    const language = config.captionLanguage;
    if (!language || this.captionLanguageDone) return;
    this.captionLanguageAttempts = (this.captionLanguageAttempts || 0) + 1;
    if (this.captionLanguageAttempts > 3) return;
    const ok = await this.setCaptionLanguage(page, language).catch(() => false);
    if (ok) {
      this.captionLanguageDone = true;
      this.log(`Caption language set to ${language}.`);
    } else if (this.captionLanguageAttempts === 3) {
      this.captionLanguageDone = true;
      this.log(
        `Could not switch captions to ${language}. In the bot's Chrome window, open the language menu at the left of ` +
          `the captions area and pick ${language}, or any participant can change the meeting language.`,
      );
    }
  }

  async setCaptionLanguage(page, language) {
    const want = new RegExp(`^\\s*${escapeRe(language)}`, 'i');
    const languageControl = () =>
      page
        .getByRole('combobox', { name: /language/i })
        .or(page.getByRole('button', { name: /(meeting|spoken|caption).{0,20}language|language.{0,20}(meeting|spoken)/i }));
    const pickOption = async () => {
      const opt = page.getByRole('option', { name: want }).or(page.getByRole('menuitemradio', { name: want }));
      for (let i = 0; i < 6 && !(await visible(opt)); i++) await wait(300);
      if (!(await visible(opt))) return false;
      await opt.first().click({ timeout: 3000 });
      await wait(500);
      // Meet may ask to confirm changing the language for everyone.
      const confirm = page
        .locator('[role="dialog"], [role="alertdialog"]')
        .getByRole('button', { name: /^(change|confirm|ok|update|apply)$/i });
      if (await visible(confirm)) await confirm.first().click({ timeout: 2000 }).catch(() => {});
      return true;
    };
    const isSelected = async () => {
      const ctl = languageControl().first();
      const text = `${await ctl.innerText().catch(() => '')} ${await ctl.getAttribute('aria-label').catch(() => '')}`;
      return new RegExp(escapeRe(language), 'i').test(text);
    };

    // 1) The language dropdown in the captions area.
    if (await visible(languageControl())) {
      if (await isSelected()) return true;
      await languageControl().first().click({ timeout: 3000 });
      if (await pickOption()) return true;
      await page.keyboard.press('Escape').catch(() => {});
    }

    // 2) More options -> Settings -> Captions -> meeting language.
    const more = page.getByRole('button', { name: /more options/i });
    if (!(await visible(more))) return false;
    await more.first().click({ timeout: 3000 });
    const settings = page.getByRole('menuitem', { name: /settings/i });
    if (!(await visible(settings))) {
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    await settings.first().click({ timeout: 3000 });
    await wait(800);
    const tab = page.getByRole('tab', { name: /captions/i });
    if (await visible(tab)) await tab.first().click({ timeout: 3000 });
    await wait(400);
    let ok = false;
    if (await visible(languageControl())) {
      ok = (await isSelected()) || (await languageControl().first().click({ timeout: 3000 }).then(pickOption));
    }
    const close = page.locator('[role="dialog"]').getByRole('button', { name: /^close/i });
    if (await visible(close)) await close.first().click({ timeout: 2000 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    return ok;
  }

  async monitor(page, joinedAt) {
    let missingLeave = 0;
    let aloneSince = null;
    let everHadOthers = false;
    let lastSlow = 0;
    let captionWarned = false;

    for (;;) {
      if (this.stopRequested) return this.stopRequested;
      if (page.isClosed()) return 'The bot browser window was closed';
      if (Date.now() - joinedAt > config.maxMeetingMs) return 'Maximum meeting length reached';

      if (await this.inCall(page)) {
        missingLeave = 0;
      } else {
        missingLeave += 1;
        const text = await this.bodyText(page);
        if (PAGE_TEXT.removed.test(text)) return 'The bot was removed from the meeting';
        if (PAGE_TEXT.ended.test(text)) return 'The meeting ended';
        // Back on the "Ready to join" screen without anyone ending the call (e.g. Meet reloaded
        // the page): rejoin instead of giving up.
        const canRejoin = await visible(page.getByRole('button', { name: JOIN_BUTTON }));
        if (canRejoin && missingLeave >= 2 && this.rejoins < 3) {
          this.rejoins += 1;
          this.emit('dropped', { at: Date.now() });
          this.log('The bot dropped out of the call (the page reloaded). Rejoining.');
          try {
            await this.join(page);
          } catch (err) {
            return `Dropped out of the call and could not rejoin: ${err.message}`;
          }
          this.status('in_meeting', 'Rejoined the meeting, transcribing');
          await this.enableCaptions(page);
          await page.evaluate(startCaptionObserver, SELECTORS).catch(() => {});
          if (config.recordAudio) await this.ensureRecorder(page);
          this.emit('rejoined', { at: Date.now() });
          missingLeave = 0;
          lastSlow = 0;
          continue;
        }
        if (missingLeave >= 3) return canRejoin ? 'Dropped out of the call' : 'The meeting ended';
      }

      if (Date.now() - lastSlow > 10_000) {
        lastSlow = Date.now();
        await this.dismissDialogs(page);

        const p = await page.evaluate(readParticipants, this.botName).catch(() => null);
        const text = await this.bodyText(page);
        if (p) {
          this.emit('participants', p);
          if (p.count > 1) everHadOthers = true;
          const alone = p.count === 1 || PAGE_TEXT.alone.test(text);
          if (alone) {
            aloneSince = aloneSince || Date.now();
            const limit = everHadOthers ? config.aloneTimeoutMs : config.admitTimeoutMs;
            if (Date.now() - aloneSince > limit) return 'Everyone else left the meeting';
          } else {
            aloneSince = null;
          }
        }

        let captionsOn = await this.captionsOn(page);
        if (!captionsOn) {
          captionsOn = await this.enableCaptions(page);
          if (!captionsOn && !captionWarned) {
            captionWarned = true;
            this.log(
              'Captions are not visible. The transcript will rely on the audio recording. You can turn captions on ' +
                "by hand in the bot's Chrome window (CC button); the bot will pick them up.",
            );
          }
        }
        await this.ensureCaptionLanguage(page);
        // Re-attach the observer and recorder if Meet reloaded the page (no-ops when running).
        await page.evaluate(startCaptionObserver, SELECTORS).catch(() => {});
        const recorder = config.recordAudio ? await this.ensureRecorder(page) : null;
        this.emit('health', { captionsOn, recorder });
      }
      await wait(2000);
    }
  }

  async leave(page) {
    this.status('leaving', 'Leaving the meeting');
    await withTimeout(
      page.evaluate(() => (window.__maStopRecorder ? window.__maStopRecorder() : null)).catch(() => {}),
      10_000,
    );
    // Give the caption observer a final tick to flush.
    await wait(1200);
    const leaveBtn = page.locator('[aria-label*="Leave call" i]');
    if (await visible(leaveBtn)) await leaveBtn.first().click({ timeout: 3000 }).catch(() => {});
    await wait(1000);
  }
}
