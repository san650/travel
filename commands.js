// Commands describe a single reversible mutation over the active vacation's
// activities. Every payload carries enough data for a deterministic revert.
// History is cleared on vacation switch, so a command always replays against
// the same vacation it was recorded on.

const active = (s) => s.doc.vacations.find((v) => v.id === s.doc.activeId);

const removeById = (s, id) => {
  const v = active(s);
  v.activities = v.activities.filter((a) => a.id !== id);
};

export const COMMANDS = {
  ADD_ACTIVITY: {
    apply: (s, p) => {
      const v = active(s);
      v.activities = [...v.activities, p.activity];
    },
    revert: (s, p) => removeById(s, p.activity.id),
    coalesceKey: (p) => p.activity.id,
    isNoOp: () => false,
  },
  ADD_ACTIVITIES: {
    apply: (s, p) => {
      const v = active(s);
      v.activities = [...v.activities, ...p.activities];
    },
    revert: (s, p) => {
      const v = active(s);
      const ids = new Set(p.activities.map((a) => a.id));
      v.activities = v.activities.filter((a) => !ids.has(a.id));
    },
    coalesceKey: (p) => p.activities[0]?.id ?? '',
    isNoOp: (p) => p.activities.length === 0,
  },
  UPDATE_ACTIVITY: {
    apply: (s, p) => {
      const v = active(s);
      v.activities = v.activities.map((a) => (a.id === p.id ? p.to : a));
    },
    revert: (s, p) => {
      const v = active(s);
      v.activities = v.activities.map((a) => (a.id === p.id ? p.from : a));
    },
    coalesceKey: (p) => p.id,
    isNoOp: (p) => JSON.stringify(p.from) === JSON.stringify(p.to),
  },
  REMOVE_ACTIVITY: {
    apply: (s, p) => removeById(s, p.activity.id),
    revert: (s, p) => {
      const v = active(s);
      const list = [...v.activities];
      list.splice(Math.min(p.index, list.length), 0, p.activity);
      v.activities = list;
    },
    coalesceKey: (p) => p.activity.id,
    isNoOp: () => false,
  },
};

export const makeCommand = (type, payload) => ({ type, payload });

export const coalesceKeyOf = (cmd) =>
  `${cmd.type}:${COMMANDS[cmd.type].coalesceKey(cmd.payload)}`;

export const isNoOp = (cmd) => COMMANDS[cmd.type].isNoOp(cmd.payload);
