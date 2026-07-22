import { COMMANDS, isNoOp, invert } from './commands.js';
import { History } from './history.js';
import {
  loadState, saveState, requestPersistence,
  loadProfile, saveProfile,
  listSyncRecords, putSyncRecord, deleteSyncRecord,
  deleteAttachmentBlob,
} from './db.js';

export const SCHEMA_VERSION = 3;

const initialState = () => ({ doc: { schemaVersion: SCHEMA_VERSION, vacations: [], activeId: null } });

// v2 (flat vacation fields, no revs) → v3 (aggregates with per-entity
// rev/updatedAt/updatedBy and tombstones). One-way. Old undo history has
// incompatible payload shapes, so migration drops it.
const migrateDoc = (state) => {
  const doc = state?.doc;
  if (!doc || !Array.isArray(doc.vacations)) return null;
  if (doc.schemaVersion === SCHEMA_VERSION) return { state, migrated: false };
  const now = new Date().toISOString();
  return {
    migrated: true,
    state: {
      doc: {
        schemaVersion: SCHEMA_VERSION,
        activeId: doc.activeId ?? null,
        vacations: doc.vacations.map((v) => ({
          id: v.id,
          revision: 0,
          meta: {
            name: v.name, start: v.start, end: v.end, base: v.base,
            rev: 0, updatedAt: now, updatedBy: null,
          },
          activities: (v.activities ?? []).map((a) => ({
            ...a, rev: 0, updatedAt: now, updatedBy: null, deletedAt: null,
          })),
          attachments: [],
        })),
      },
    },
  };
};

class Store {
  constructor() {
    this.state = initialState();
    this.history = new History();
    this.listeners = new Set();
    this.persistError = false;
    this.actor = null;      // local display name, cosmetic only
    this.sync = new Map();  // travelId -> sync record (presence == shared)
    this.ready = this.#hydrate();
  }

  async #hydrate() {
    try {
      const persisted = await loadState();
      if (persisted) {
        const migrated = migrateDoc(persisted.state);
        if (migrated) {
          this.state = migrated.state;
          if (!migrated.migrated && persisted.history) this.history.hydrate(persisted.history);
          if (migrated.migrated) this.#persist();
        }
      }
      const profile = await loadProfile();
      if (profile?.name) this.actor = profile.name;
      this.sync = await listSyncRecords();
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

  // ---------- profile ----------

  setActor(name) {
    this.actor = name || null;
    saveProfile({ name: this.actor }).catch((err) => console.error('profile persist failed', err));
  }

  // ---------- sync records (presence == travel is shared) ----------

  isShared(travelId) { return this.sync.has(travelId); }
  syncRecord(travelId) { return this.sync.get(travelId) ?? null; }
  pendingCount(travelId) { return this.sync.get(travelId)?.pending.length ?? 0; }

  setSyncRecord(travelId, rec) {
    this.sync.set(travelId, rec);
    this.#persistSync(travelId);
    this.#notify();
  }

  removeSyncRecord(travelId) {
    this.sync.delete(travelId);
    deleteSyncRecord(travelId).catch((err) => console.error('sync record delete failed', err));
    this.#notify();
  }

  #persistSync(travelId) {
    const rec = this.sync.get(travelId);
    if (!rec) return;
    putSyncRecord(travelId, rec).catch((err) => console.error('sync record persist failed', err));
  }

  #appendPending(travelId, cmd, coalesced) {
    const rec = this.sync.get(travelId);
    if (!rec) return;
    const last = rec.pending[rec.pending.length - 1];
    if (coalesced && last && last.cmdId === cmd.cmdId) {
      rec.pending[rec.pending.length - 1] = cmd;
    } else {
      rec.pending.push(cmd);
    }
    this.#persistSync(travelId);
  }

  // Bookkeeping del motor de sync tras subir binarios: no pasa por comandos
  // ni limpia historial (driveFileId no es estado de dominio).
  patchAttachmentDriveIds(travelId, idMap) {
    const next = structuredClone(this.state);
    const travel = next.doc.vacations.find((v) => v.id === travelId);
    if (!travel) return;
    travel.attachments = travel.attachments.map((a) =>
      idMap[a.id] ? { ...a, driveFileId: idMap[a.id] } : a);
    this.state = next;
    this.#persist();
    this.#notify();
  }

  // Used by the sync engine: replace a travel aggregate with a merged/remote
  // snapshot. Clears undo history (its commands no longer match the state).
  replaceTravel(travelId, travel) {
    const next = structuredClone(this.state);
    next.doc.vacations = next.doc.vacations.map((v) => (v.id === travelId ? travel : v));
    this.state = next;
    this.history.clear();
    this.#persist();
    this.#notify();
  }

  adoptTravel(travel, syncRecord) {
    const next = structuredClone(this.state);
    next.doc.vacations = [...next.doc.vacations.filter((v) => v.id !== travel.id), travel];
    next.doc.activeId = travel.id;
    this.state = next;
    this.history.clear();
    if (syncRecord) this.sync.set(travel.id, syncRecord);
    if (syncRecord) this.#persistSync(travel.id);
    this.#persist();
    this.#notify();
  }

  // ---------- lifecycle (bypass commands, clear history) ----------

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
    const gone = this.state.doc.vacations.find((v) => v.id === id);
    this.#lifecycle((s) => {
      s.doc.vacations = s.doc.vacations.filter((v) => v.id !== id);
      if (s.doc.activeId === id) s.doc.activeId = s.doc.vacations[0]?.id ?? null;
    });
    if (this.sync.has(id)) this.removeSyncRecord(id);
    for (const att of gone?.attachments ?? []) {
      deleteAttachmentBlob(att.id).catch(() => {});
    }
  }

  switchVacation(id) {
    if (!this.state.doc.vacations.some((v) => v.id === id)) return;
    this.#lifecycle((s) => { s.doc.activeId = id; });
  }

  // ---------- commands ----------

  dispatch(cmd) {
    const def = COMMANDS[cmd.type];
    if (!def) throw new Error(`Unknown command: ${cmd.type}`);
    if (isNoOp(cmd)) return;
    const stamped = { ...cmd, cmdId: crypto.randomUUID(), actor: this.actor, ts: Date.now() };
    const next = structuredClone(this.state);
    const travel = next.doc.vacations.find((v) => v.id === next.doc.activeId);
    if (!travel) return;
    def.apply(travel, stamped.payload, stamped);
    this.state = next;
    const { cmd: recorded, coalesced } = this.history.record(stamped);
    this.#appendPending(travel.id, recorded, coalesced);
    this.#persist();
    this.#notify();
  }

  undo() {
    const cmd = this.history.popUndo();
    if (!cmd) return null;
    const next = structuredClone(this.state);
    const travel = next.doc.vacations.find((v) => v.id === next.doc.activeId);
    if (!travel) return null;
    COMMANDS[cmd.type].revert(travel, cmd.payload);
    this.state = next;
    this.history.pushFuture(cmd);
    const rec = this.sync.get(travel.id);
    if (rec) {
      const last = rec.pending[rec.pending.length - 1];
      if (last && last.cmdId === cmd.cmdId) {
        rec.pending.pop();
      } else {
        // The command already synced (or predates the log): log its inverse
        // so the net effect reaches the remote on next sync.
        rec.pending.push({
          ...invert(cmd),
          cmdId: crypto.randomUUID(),
          actor: this.actor,
          ts: Date.now(),
          inverts: cmd.cmdId,
        });
      }
      this.#persistSync(travel.id);
    }
    this.#persist();
    this.#notify();
    return cmd;
  }

  redo() {
    const cmd = this.history.popRedo();
    if (!cmd) return null;
    const next = structuredClone(this.state);
    const travel = next.doc.vacations.find((v) => v.id === next.doc.activeId);
    if (!travel) return null;
    COMMANDS[cmd.type].apply(travel, cmd.payload, cmd);
    this.state = next;
    this.history.pushPast(cmd);
    const rec = this.sync.get(travel.id);
    if (rec) {
      const last = rec.pending[rec.pending.length - 1];
      if (last && last.inverts === cmd.cmdId) {
        rec.pending.pop();
      } else {
        // Fresh cmdId: the original entry may still sit earlier in the log.
        rec.pending.push({ ...cmd, cmdId: crypto.randomUUID() });
      }
      this.#persistSync(travel.id);
    }
    this.#persist();
    this.#notify();
    return cmd;
  }

  canUndo() { return this.history.canUndo(); }
  canRedo() { return this.history.canRedo(); }
}

export const store = new Store();
