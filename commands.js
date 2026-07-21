// Commands describe a single reversible mutation over state.doc.activities.
// Every payload carries enough data for a deterministic revert.

const removeById = (s, id) => {
  s.doc.activities = s.doc.activities.filter((a) => a.id !== id);
};

export const COMMANDS = {
  ADD_ACTIVITY: {
    apply: (s, p) => { s.doc.activities = [...s.doc.activities, p.activity]; },
    revert: (s, p) => removeById(s, p.activity.id),
    coalesceKey: (p) => p.activity.id,
    isNoOp: () => false,
  },
  ADD_ACTIVITIES: {
    apply: (s, p) => { s.doc.activities = [...s.doc.activities, ...p.activities]; },
    revert: (s, p) => {
      const ids = new Set(p.activities.map((a) => a.id));
      s.doc.activities = s.doc.activities.filter((a) => !ids.has(a.id));
    },
    coalesceKey: (p) => p.activities[0]?.id ?? '',
    isNoOp: (p) => p.activities.length === 0,
  },
  UPDATE_ACTIVITY: {
    apply: (s, p) => {
      s.doc.activities = s.doc.activities.map((a) => (a.id === p.id ? p.to : a));
    },
    revert: (s, p) => {
      s.doc.activities = s.doc.activities.map((a) => (a.id === p.id ? p.from : a));
    },
    coalesceKey: (p) => p.id,
    isNoOp: (p) => JSON.stringify(p.from) === JSON.stringify(p.to),
  },
  REMOVE_ACTIVITY: {
    apply: (s, p) => removeById(s, p.activity.id),
    revert: (s, p) => {
      const list = [...s.doc.activities];
      list.splice(Math.min(p.index, list.length), 0, p.activity);
      s.doc.activities = list;
    },
    coalesceKey: (p) => p.activity.id,
    isNoOp: () => false,
  },
};

export const makeCommand = (type, payload) => ({ type, payload });

export const coalesceKeyOf = (cmd) =>
  `${cmd.type}:${COMMANDS[cmd.type].coalesceKey(cmd.payload)}`;

export const isNoOp = (cmd) => COMMANDS[cmd.type].isNoOp(cmd.payload);
