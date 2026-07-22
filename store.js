import { COMMANDS, isNoOp } from './commands.js';
import { History } from './history.js';
import { loadState, saveState, requestPersistence } from './db.js';

const initialState = () => ({ doc: { vacations: [], activeId: null } });

class Store {
  constructor() {
    this.state = initialState();
    this.history = new History();
    this.listeners = new Set();
    this.persistError = false;
    this.ready = this.#hydrate();
  }

  async #hydrate() {
    try {
      const persisted = await loadState();
      if (persisted) {
        if (Array.isArray(persisted.state?.doc?.vacations)) this.state = persisted.state;
        if (persisted.history) this.history.hydrate(persisted.history);
      }
    } catch (err) {
      console.error('hydrate failed', err);
    }
    requestPersistence();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify() { for (const fn of this.listeners) fn(this.state); }

  async #persist() {
    try {
      await saveState({ state: this.state, history: this.history.serialize() });
      if (this.persistError) { this.persistError = false; this.#notify(); }
    } catch (err) {
      console.error('persist failed', err);
      if (!this.persistError) { this.persistError = true; this.#notify(); }
    }
  }

  activeVacation() {
    const { vacations, activeId } = this.state.doc;
    return vacations.find((v) => v.id === activeId) ?? null;
  }

  // Lifecycle actions bypass commands and clear history.
  #lifecycle(mutate) {
    const next = structuredClone(this.state);
    mutate(next);
    this.state = next;
    this.history.clear();
    this.#persist();
    this.#notify();
  }

  createVacation(vacation) {
    this.#lifecycle((s) => {
      s.doc.vacations = [...s.doc.vacations, vacation];
      s.doc.activeId = vacation.id;
    });
  }

  deleteVacation(id) {
    this.#lifecycle((s) => {
      s.doc.vacations = s.doc.vacations.filter((v) => v.id !== id);
      if (s.doc.activeId === id) s.doc.activeId = s.doc.vacations[0]?.id ?? null;
    });
  }

  switchVacation(id) {
    if (!this.state.doc.vacations.some((v) => v.id === id)) return;
    this.#lifecycle((s) => { s.doc.activeId = id; });
  }

  replaceActivities(activities) {
    this.#lifecycle((s) => {
      const v = s.doc.vacations.find((x) => x.id === s.doc.activeId);
      if (v) v.activities = activities;
    });
  }

  dispatch(cmd) {
    const def = COMMANDS[cmd.type];
    if (!def) throw new Error(`Unknown command: ${cmd.type}`);
    if (isNoOp(cmd)) return;
    const next = structuredClone(this.state);
    def.apply(next, cmd.payload);
    this.state = next;
    this.history.record(cmd);
    this.#persist();
    this.#notify();
  }

  undo() {
    const cmd = this.history.popUndo();
    if (!cmd) return null;
    const next = structuredClone(this.state);
    COMMANDS[cmd.type].revert(next, cmd.payload);
    this.state = next;
    this.history.pushFuture(cmd);
    this.#persist();
    this.#notify();
    return cmd;
  }

  redo() {
    const cmd = this.history.popRedo();
    if (!cmd) return null;
    const next = structuredClone(this.state);
    COMMANDS[cmd.type].apply(next, cmd.payload);
    this.state = next;
    this.history.pushPast(cmd);
    this.#persist();
    this.#notify();
    return cmd;
  }

  canUndo() { return this.history.canUndo(); }
  canRedo() { return this.history.canRedo(); }
}

export const store = new Store();
