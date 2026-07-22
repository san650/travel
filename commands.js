// Commands describe a single reversible mutation over one travel aggregate.
// apply/revert receive the travel object (not the whole doc) so the same
// definitions run for local dispatch and for sync replay onto a remote
// snapshot. ctx ({ ts, actor }) comes from the stamped command; apply() bumps
// the target entity's rev and stamps updatedAt/updatedBy, so a replay of the
// same command is deterministic. Deletes are tombstones (deletedAt) so a
// merge can tell a delete apart from never-existed.
// History is cleared on vacation switch, so a command always replays against
// the same vacation it was recorded on.

export const alive = (list) => list.filter((a) => !a.deletedAt);

const iso = (ts) => new Date(ts).toISOString();

const stampNew = (entity, ctx) => ({
  ...entity,
  rev: 1,
  updatedAt: iso(ctx.ts),
  updatedBy: ctx.actor ?? null,
  deletedAt: null,
});

const stampNext = (entity, baseRev, ctx) => ({
  ...entity,
  rev: (baseRev ?? 0) + 1,
  updatedAt: iso(ctx.ts),
  updatedBy: ctx.actor ?? null,
  deletedAt: null,
});

const tombstone = (a, ctx) => ({
  ...a,
  rev: (a.rev ?? 0) + 1,
  updatedAt: iso(ctx.ts),
  updatedBy: ctx.actor ?? null,
  deletedAt: iso(ctx.ts),
});

// upsert instead of push: on sync replay the entity may already exist
// remotely (e.g. restore of a remotely-tombstoned activity).
const upsert = (list, entity) =>
  list.some((a) => a.id === entity.id)
    ? list.map((a) => (a.id === entity.id ? entity : a))
    : [...list, entity];

// Sync-irrelevant bookkeeping stripped before comparing domain content.
const domain = ({ rev, updatedAt, updatedBy, deletedAt, ...rest }) => rest;
const sameDomain = (a, b) => JSON.stringify(domain(a)) === JSON.stringify(domain(b));

export const COMMANDS = {
  ADD_ACTIVITY: {
    apply: (v, p, ctx) => { v.activities = upsert(v.activities, stampNew(p.activity, ctx)); },
    revert: (v, p) => { v.activities = v.activities.filter((a) => a.id !== p.activity.id); },
    coalesceKey: (p) => p.activity.id,
    isNoOp: () => false,
    targets: () => [],
  },
  ADD_ACTIVITIES: {
    apply: (v, p, ctx) => {
      for (const a of p.activities) v.activities = upsert(v.activities, stampNew(a, ctx));
    },
    revert: (v, p) => {
      const ids = new Set(p.activities.map((a) => a.id));
      v.activities = v.activities.filter((a) => !ids.has(a.id));
    },
    coalesceKey: (p) => p.activities[0]?.id ?? '',
    isNoOp: (p) => p.activities.length === 0,
    targets: () => [],
  },
  UPDATE_ACTIVITY: {
    apply: (v, p, ctx) => {
      v.activities = v.activities.map((a) =>
        a.id === p.id ? stampNext(p.to, p.from.rev, ctx) : a);
    },
    revert: (v, p) => {
      v.activities = v.activities.map((a) => (a.id === p.id ? p.from : a));
    },
    coalesceKey: (p) => p.id,
    isNoOp: (p) => sameDomain(p.from, p.to),
    targets: (p) => [{ id: p.id, baseRev: p.from.rev ?? 0 }],
  },
  REMOVE_ACTIVITY: {
    apply: (v, p, ctx) => {
      v.activities = v.activities.map((a) =>
        a.id === p.activity.id ? tombstone(a, ctx) : a);
    },
    revert: (v, p) => {
      v.activities = v.activities.map((a) => (a.id === p.activity.id ? p.activity : a));
    },
    coalesceKey: (p) => p.activity.id,
    isNoOp: () => false,
    targets: (p) => [{ id: p.activity.id, baseRev: p.activity.rev ?? 0 }],
  },
  REMOVE_ACTIVITIES: {
    apply: (v, p, ctx) => {
      const ids = new Set(p.activities.map((a) => a.id));
      v.activities = v.activities.map((a) => (ids.has(a.id) ? tombstone(a, ctx) : a));
    },
    revert: (v, p) => {
      const byId = new Map(p.activities.map((a) => [a.id, a]));
      v.activities = v.activities.map((a) => byId.get(a.id) ?? a);
    },
    coalesceKey: (p) => p.activities[0]?.id ?? '',
    isNoOp: (p) => p.activities.length === 0,
    targets: (p) => p.activities.map((a) => ({ id: a.id, baseRev: a.rev ?? 0 })),
  },
  // Import-replace: tombstone everything alive, then add the new set.
  // p.prev is the alive snapshot at dispatch time (for revert + conflicts).
  SET_ACTIVITIES: {
    apply: (v, p, ctx) => {
      v.activities = [
        ...v.activities.map((a) => (a.deletedAt ? a : tombstone(a, ctx))),
        ...p.activities.map((a) => stampNew(a, ctx)),
      ];
    },
    revert: (v, p) => {
      const added = new Set(p.activities.map((a) => a.id));
      const prevById = new Map(p.prev.map((a) => [a.id, a]));
      v.activities = v.activities
        .filter((a) => !added.has(a.id))
        .map((a) => prevById.get(a.id) ?? a);
    },
    coalesceKey: () => '',
    isNoOp: (p) => p.activities.length === 0 && p.prev.length === 0,
    targets: (p) => p.prev.map((a) => ({ id: a.id, baseRev: a.rev ?? 0 })),
  },
  // Adjuntos: la entidad (metadata) vive en travel.attachments; el binario
  // local en IndexedDB (store 'attachments') y el remoto como archivo suelto
  // en la carpeta del viaje. driveFileId null = todavía no subido.
  ADD_ATTACHMENT: {
    apply: (v, p, ctx) => { v.attachments = upsert(v.attachments, stampNew(p.attachment, ctx)); },
    revert: (v, p) => { v.attachments = v.attachments.filter((a) => a.id !== p.attachment.id); },
    coalesceKey: (p) => p.attachment.id,
    isNoOp: () => false,
    targets: () => [],
  },
  REMOVE_ATTACHMENT: {
    apply: (v, p, ctx) => {
      v.attachments = v.attachments.map((a) =>
        a.id === p.attachment.id ? tombstone(a, ctx) : a);
    },
    revert: (v, p) => {
      v.attachments = v.attachments.map((a) => (a.id === p.attachment.id ? p.attachment : a));
    },
    coalesceKey: (p) => p.attachment.id,
    isNoOp: () => false,
    targets: (p) => [{ col: 'attachments', id: p.attachment.id, baseRev: p.attachment.rev ?? 0 }],
  },
  UPDATE_VACATION_META: {
    apply: (v, p, ctx) => { v.meta = stampNext(p.to, p.from.rev, ctx); },
    revert: (v, p) => { v.meta = p.from; },
    coalesceKey: () => 'meta',
    isNoOp: (p) => sameDomain(p.from, p.to),
    targets: (p) => [{ id: 'meta', baseRev: p.from.rev ?? 0 }],
  },
};

export const makeCommand = (type, payload) => ({ type, payload });

// Inverse command for the pending sync log when undoing an already-logged
// (or already-synced) command. Local state uses revert() for exactness; the
// inverse only needs to produce the same net effect on a remote replay.
export const invert = (cmd) => {
  const p = cmd.payload;
  const ctx = { ts: cmd.ts, actor: cmd.actor };
  switch (cmd.type) {
    case 'ADD_ACTIVITY':
      return makeCommand('REMOVE_ACTIVITY', { activity: stampNew(p.activity, ctx) });
    case 'ADD_ACTIVITIES':
      return makeCommand('REMOVE_ACTIVITIES', { activities: p.activities.map((a) => stampNew(a, ctx)) });
    case 'REMOVE_ACTIVITY':
      return makeCommand('ADD_ACTIVITY', { activity: p.activity });
    case 'ADD_ATTACHMENT':
      return makeCommand('REMOVE_ATTACHMENT', { attachment: stampNew(p.attachment, ctx) });
    case 'REMOVE_ATTACHMENT':
      return makeCommand('ADD_ATTACHMENT', { attachment: p.attachment });
    case 'REMOVE_ACTIVITIES':
      return makeCommand('ADD_ACTIVITIES', { activities: p.activities });
    case 'UPDATE_ACTIVITY':
      return makeCommand('UPDATE_ACTIVITY', {
        id: p.id,
        from: stampNext(p.to, p.from.rev, ctx),
        to: p.from,
      });
    case 'SET_ACTIVITIES':
      return makeCommand('SET_ACTIVITIES', {
        activities: p.prev.map(domain),
        prev: p.activities.map((a) => stampNew(a, ctx)),
      });
    case 'UPDATE_VACATION_META':
      return makeCommand('UPDATE_VACATION_META', {
        from: stampNext(p.to, p.from.rev, ctx),
        to: p.from,
      });
    default:
      throw new Error(`Cannot invert: ${cmd.type}`);
  }
};

// Entities a command asserts a base revision on; sync uses this to detect
// that the same entity also changed remotely since this client's base.
export const conflictTargets = (cmd) =>
  COMMANDS[cmd.type].targets(cmd.payload);

export const coalesceKeyOf = (cmd) =>
  `${cmd.type}:${COMMANDS[cmd.type].coalesceKey(cmd.payload)}`;

export const isNoOp = (cmd) => COMMANDS[cmd.type].isNoOp(cmd.payload);
