import { coalesceKeyOf } from './commands.js';

const COALESCE_WINDOW_MS = 700;
const MAX_ENTRIES = 200;

export class History {
  constructor() {
    this.past = [];
    this.future = [];
  }

  hydrate({ past = [], future = [] } = {}) {
    this.past = Array.isArray(past) ? past.slice(-MAX_ENTRIES) : [];
    this.future = Array.isArray(future) ? future : [];
  }

  serialize() {
    return { past: this.past, future: this.future };
  }

  // cmd arrives already stamped (cmdId/actor/ts) by the store. Returns the
  // entry actually stored: on coalesce it keeps the previous entry's cmdId so
  // the pending sync log can match and merge the same way.
  record(cmd) {
    const last = this.past[this.past.length - 1];
    if (
      last &&
      last.type === cmd.type &&
      cmd.type === 'UPDATE_ACTIVITY' &&
      coalesceKeyOf(last) === coalesceKeyOf(cmd) &&
      cmd.ts - last.ts < COALESCE_WINDOW_MS
    ) {
      const merged = {
        ...last,
        payload: { ...last.payload, to: cmd.payload.to },
        ts: cmd.ts,
      };
      this.past[this.past.length - 1] = merged;
      this.future = [];
      return { cmd: merged, coalesced: true };
    }
    this.past.push(cmd);
    if (this.past.length > MAX_ENTRIES) this.past.shift();
    this.future = [];
    return { cmd, coalesced: false };
  }

  popUndo() { return this.past.pop() ?? null; }
  popRedo() { return this.future.pop() ?? null; }
  pushPast(cmd) { this.past.push(cmd); }
  pushFuture(cmd) { this.future.push(cmd); }
  clear() { this.past = []; this.future = []; }
  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }
}
