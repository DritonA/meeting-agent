# Meeting Agent

A bot that joins a Google Meet call from its link, writes down who said what, and produces meeting notes when the call ends.

For every meeting you get:

| File | What it is |
|---|---|
| `notes.md` | AI meeting notes: summary, topics, decisions, action items (owner and due date), open questions, per-person highlights, speaking time |
| `transcript.md` / `.txt` / `.json` | Full transcript with speaker names and timestamps |
| `audio.webm` | Audio recording of the meeting (backup). If the recorder had to restart, later parts are `audio-2.webm`, `audio-3.webm`, … |
| `audio-transcript.md` | Optional second transcript made from the audio by Soniox or Deepgram |
| `log.txt` | What the bot did, for troubleshooting |

Files are saved in `data/meetings/<date>_<meeting-code>/` while the meeting is running, so a crash never loses the conversation captured so far.

## Setup

Requirements: Node.js 18.17 or newer, and Google Chrome.

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

In `.env`, set `ANTHROPIC_API_KEY` to get AI notes. Without it you still get the full transcript and recording.

If Chrome isn't installed, run `npx playwright install chromium` and set `BROWSER_CHANNEL=chromium`.

### Optional: sign the bot into a Google account

Many company meetings don't accept anonymous guests ("You can't join this video call"). Give the bot its own Google account (for example `notetaker@yourcompany.com`) and sign in once:

```bash
npm run login
```

A Chrome window opens on the bot's own profile. Sign in, then close the window. From then on the bot joins as that account. This profile is separate from your personal Chrome.

## Use it

### Web app

```bash
npm start
```

Open http://localhost:3000, paste a Meet link, and click **Send bot to meeting**. Then:

1. A Chrome window opens and the bot asks to join. **Admit it from the meeting.**
2. The transcript fills in live, with speaker names, as people talk.
3. When the meeting ends (or everyone else leaves, or you click **Leave meeting**), notes appear in the **Notes** tab and all files can be downloaded.

You can reopen past meetings from the sidebar and use **Regenerate notes** at any time. If a transcription service is set up, **Transcribe audio** (with a Soniox / Deepgram choice) transcribes the recording again, for example to compare the two services. Then click **Regenerate notes** to use the new transcript.

If anything goes wrong with capture, the meeting page shows a red **capture problem** box. This covers captions turning off, the recording going silent or restarting, and the bot dropping out of the call. The box stays after the meeting (the meeting shows "Finished with issues"), and the problems are listed at the top of `notes.md`, so a meeting with missing parts never looks complete.

### Windows desktop app

The same app, as a normal Windows program: no terminal, no Node.js, no project folder. Install it on any Windows PC.

**Install.** Run `Meeting Agent-<version>-setup.exe`. It installs for the current user (no admin rights needed) and adds Start-menu and desktop shortcuts. Or use `Meeting Agent-<version>-portable.exe`, which runs without installing (for example from a USB stick). The files are not code-signed, so Windows SmartScreen may warn first. Click **More info → Run anyway**.

**First start.** The **Settings** window opens. Paste your Anthropic API key and click **Save**, and AI notes are on right away. No restart and no files to edit. Everything else can stay as it is. The app needs Google Chrome or Microsoft Edge on the PC. Edge comes with Windows and is used when Chrome isn't installed.

**Settings.** Open them with the **Settings** button at the top right, or **File → Settings…** (Ctrl+,). They cover everything `.env` has: API keys (Anthropic, Soniox, Deepgram), notes model and language, bot name, caption language, browser, audio recording, transcription service and language, and under **Advanced** the timeouts, meetings folder and port. Changes apply when you save. Only the meetings folder and port ask for a restart.

**How keys are protected:**

- API keys are encrypted with Windows' data protection (DPAPI, through Electron `safeStorage`) and saved in `settings.json`. Only your Windows account on that PC can decrypt them. A copy of the file on another PC or account is useless; the app asks for the key again there.
- After saving, a key is never shown again. The window shows only "Saved securely · ends in …abcd", with **Replace** and **Remove**.
- Keys stay in the app's main process. They don't go through the local web server, aren't put in environment variables (so the bot's browser never gets them), and aren't written to logs.
- The settings window is a local page with a strict content security policy. It can only load, save and pick a folder. The main window can only open it.

**Other menus:**

- **File → Open meetings folder** opens the saved transcripts, notes and recordings.
- **Bot → Sign in to Google account…** signs the bot in (same as `npm run login`).

Everything the desktop app keeps is in `%APPDATA%\Meeting Agent`: `settings.json`, the bot's browser profile, and `data\meetings`. It is separate from the project folder, so the desktop app and `npm start` don't share meetings or settings. The desktop app ignores `.env`. To use a different folder, for example a separate test setup, set the `MEETING_AGENT_APPDATA` environment variable to it before starting the app. If you close the app while the bot is in a meeting, it asks first, then leaves the call and saves the transcript and notes before it closes.

**Build the installer** (on Windows, from the project folder):

```bash
pnpm install
pnpm dist:win        # writes dist/Meeting Agent-<version>-setup.exe and -portable.exe
pnpm desktop         # or: run the desktop app from source, without building
```

The installer never includes your `.env`, keys, the bot profile or any meetings. Each PC gets its own settings on first start.

### Command line

```bash
npm run join -- https://meet.google.com/abc-defg-hij --title "Weekly sync"
```

Finished lines are printed as people talk. Press Ctrl+C to make the bot leave; notes are written before it exits.

To rebuild the notes of a saved meeting:

```bash
npm run notes -- 2026-11-18_1430_abc-defg-hij
```

## How it works

1. **Joining.** Playwright opens Chrome on the Meet link with the bot's profile. The bot fills in its name, turns off its camera and microphone, and clicks **Ask to join** or **Join now**. Its camera and mic are fake devices (a silent sound file and a blank image), so it can never send your real audio or video.
2. **Who said what.** The bot turns on Meet's live captions and reads them from the page. Meet labels each caption with the speaker's real name, so the transcript uses real names, not "Speaker 1". Meet edits captions in place while people talk, so the bot merges each update without dropping or repeating words.
3. **Audio backup.** The bot records the call's audio to `audio.webm` and checks every 10 seconds that the recorder is running and actually hearing sound. If Meet reloads the page, the bot rejoins and starts a new recording file. If you set a Soniox or Deepgram key, the recording is also transcribed with speaker separation. Its speakers are matched to names using the captions, which fills any gaps the captions missed.
4. **Notes.** When the meeting is over, the transcript goes to Claude (`claude-opus-5-5` by default), which writes the structured notes.
5. **Leaving.** The bot leaves when the meeting ends, when it's removed, after it has been alone for 3 minutes, when you stop it, or after 4 hours.

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Needed for AI notes |
| `NOTES_MODEL` | `claude-opus-5-5` | Claude model used for notes |
| `BOT_NAME` | `Meeting Notetaker` | Name shown in the meeting (for guest joins) |
| `BROWSER_CHANNEL` | `chrome` | `chrome`, `msedge`, or `chromium` |
| `HEADLESS` | `false` | `true` hides the browser window (Google is more likely to block hidden browsers) |
| `ADMIT_TIMEOUT_MINUTES` | `15` | How long to wait to be admitted |
| `ALONE_TIMEOUT_MINUTES` | `3` | Leave after being alone this long |
| `MAX_MEETING_MINUTES` | `240` | Hard stop |
| `RECORD_AUDIO` | `true` | Save `audio.webm` |
| `CAPTION_LANGUAGE` | | Caption language the bot selects in Meet, e.g. `Albanian`. Must match the language spoken |
| `NOTES_LANGUAGE` | | Language of `notes.md`, e.g. `English`. Empty = same as the meeting |
| `TRANSCRIPTION_PROVIDER` | first with a key | Audio transcription service: `soniox`, `deepgram`, or `none` |
| `TRANSCRIPTION_LANGUAGE` | | Language code of the speech, e.g. `sq` for Albanian. Empty = auto-detect |
| `SONIOX_API_KEY` | | Soniox key (Albanian supported) |
| `SONIOX_MODEL` | `stt-async-v6` | Soniox model |
| `DEEPGRAM_API_KEY` | | Deepgram key (Albanian support not confirmed) |
| `PORT` | `3000` | Web app port |

## Good to know

- **Tell people they are being recorded.** The bot appears in the participant list under its name. Recording and transcription laws differ by country and state, and many require everyone's consent.
- **Audio leaves your computer only for transcription.** With Soniox, the file is uploaded, transcribed, and then deleted from Soniox right away. Notes send only the text transcripts to Claude.
- **One bot at a time.** The bot uses a single Chrome profile, so it can be in one meeting at a time.
- **Caption language.** The transcript is only as good as Meet's captions, and captions must be set to the language people actually speak. Set `CAPTION_LANGUAGE` (for example `Albanian`) and the bot selects it in Meet when it joins. If it can't, the log says so: pick the language in the dropdown at the left of the captions area in the bot's window. Albanian captions are marked beta by Google, so expect more recognition errors than in English. Claude fixes obvious ones when writing the notes.
- **Meet updates.** Google can change Meet's page layout at any time. If the transcript stays empty while captions are clearly showing in the bot's window, update the lists in `src/meet/selectors.js` (instructions are at the top of that file). The bot also falls back to reading the captions by their structure, and the audio recording is always kept as a backup.

## Development

```bash
npm test
```

Main pieces of the code:

- `src/meet/bot.js` joins Meet, enables captions, watches for the end, and leaves.
- `src/meet/inpage.js` holds the scripts that run inside the Meet page: the caption reader, audio recorder, and participant list.
- `src/meet/selectors.js` holds the Meet page selectors and status messages.
- `src/transcript/` merges caption updates into a transcript.
- `src/session.js` runs one meeting from start to finish: it saves files, transcribes the audio, and writes the notes.
- `src/notes/claude.js` asks Claude for the notes.
- `src/stt/` holds the audio transcription services (Soniox, Deepgram) and matches their speakers to names.
- `src/server.js` and `public/` are the web app.
- `electron/main.js` is the Windows desktop app. It runs `src/server.js` inside the app and shows `public/` in its own window. `electron/settings-store.js` keeps its settings (keys encrypted), and `electron/settings.*` is the settings window.
