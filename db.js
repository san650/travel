const DB_NAME = 'travel-42uy';
const DB_VERSION = 2;
const STATE = 'state';
const SYNC = 'sync';
const ATTACHMENTS = 'attachments';
const DOC_KEY = 'app';
const PROFILE_KEY = 'profile';

let dbPromise = null;

const openDb = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [STATE, SYNC, ATTACHMENTS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  // Drop a rejected open so the next operation retries instead of staying
  // bricked until reload.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
};

const tx = async (store, mode) => {
  const db = await openDb();
  return db.transaction(store, mode).objectStore(store);
};

const reqAsPromise = (r) =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

const get = async (store, key) => reqAsPromise((await tx(store, 'readonly')).get(key)).then((v) => v ?? null);
const put = async (store, key, value) => reqAsPromise((await tx(store, 'readwrite')).put(value, key));
const del = async (store, key) => reqAsPromise((await tx(store, 'readwrite')).delete(key));

// ---------- app state ----------

export const loadState = () => get(STATE, DOC_KEY);
export const saveState = (state) => put(STATE, DOC_KEY, state);

// ---------- local profile (display name for updatedBy) ----------

export const loadProfile = () => get(STATE, PROFILE_KEY);
export const saveProfile = (profile) => put(STATE, PROFILE_KEY, profile);

// ---------- config de Google (client id, api key, app id) ----------

export const loadDriveConfig = () => get(STATE, 'drive-config');
export const saveDriveConfig = (cfg) => put(STATE, 'drive-config', cfg);

// ---------- per-travel sync records ----------
// { driveFolderId, driveFileId, baseRevision, baseDriveVersion, lastSyncAt, pending: [] }

export const getSyncRecord = (travelId) => get(SYNC, travelId);
export const putSyncRecord = (travelId, rec) => put(SYNC, travelId, rec);
export const deleteSyncRecord = (travelId) => del(SYNC, travelId);

export const listSyncRecords = async () => {
  const s = await tx(SYNC, 'readonly');
  const [keys, values] = await Promise.all([
    reqAsPromise(s.getAllKeys()),
    reqAsPromise(s.getAll()),
  ]);
  const map = new Map();
  keys.forEach((k, i) => map.set(k, values[i]));
  return map;
};

// ---------- attachment blobs ----------

export const getAttachmentBlob = (id) => get(ATTACHMENTS, id);
export const putAttachmentBlob = (id, blob) => put(ATTACHMENTS, id, blob);
export const deleteAttachmentBlob = (id) => del(ATTACHMENTS, id);

export const requestPersistence = async () => {
  if (navigator.storage?.persist) {
    try { await navigator.storage.persist(); } catch {}
  }
};
