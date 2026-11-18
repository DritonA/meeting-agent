import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { MeetingSession } from './session.js';

/** Keeps every meeting (running and past) available to the server. */
export class Registry {
  constructor() {
    this.sessions = new Map();
    fs.mkdirSync(config.dataDir, { recursive: true });
    for (const name of fs.readdirSync(config.dataDir)) {
      const dir = path.join(config.dataDir, name);
      if (!fs.existsSync(path.join(dir, 'meta.json'))) continue;
      try {
        const s = MeetingSession.load(dir);
        this.sessions.set(s.meta.id, s);
      } catch (err) {
        console.warn(`Skipping ${dir}: ${err.message}`);
      }
    }
  }

  list() {
    return [...this.sessions.values()].map((s) => s.summary()).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    return this.sessions.get(id);
  }

  activeBot() {
    // A session holds the browser until its bot has left the call ('processing' no longer needs it).
    return [...this.sessions.values()].find((s) =>
      ['starting', 'joining', 'waiting_admission', 'in_meeting', 'leaving'].includes(s.meta.status),
    );
  }

  start({ url, botName, title }) {
    const busy = this.activeBot();
    if (busy) {
      const err = new Error(
        `The bot is already in "${busy.meta.title}". Stop it first. One bot runs at a time because it uses one browser profile.`,
      );
      err.status = 409;
      throw err;
    }
    const s = MeetingSession.create({ url, botName, title });
    this.sessions.set(s.meta.id, s);
    s.start();
    return s;
  }
}
