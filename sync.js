// Motor de sincronización por viaje. Modelo manual (leer al abrir, guardar a
// pedido, resincronizar explícito): nada corre en segundo plano. El archivo
// remoto travel.json guarda un snapshot del agregado + un contador de
// revisión; los cambios locales desde la última sincronización viven como
// comandos pendientes (rec.pending) y se re-aplican sobre el snapshot remoto
// fresco. Entidades disjuntas se fusionan solas; si un comando toca una
// entidad que también cambió remotamente (rev distinta a la base del
// comando), es un conflicto y decide el usuario (mío/de ellos).

import { store } from './store.js';
import { COMMANDS, conflictTargets } from './commands.js';
import * as drive from './drive.js';
import { getAttachmentBlob } from './db.js';

const SCHEMA = 3;
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

export class SyncError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const nowIso = () => new Date().toISOString();

const localTravel = (travelId) =>
  store.state.doc.vacations.find((v) => v.id === travelId) ?? null;

// ---------- formato remoto ----------

const freshTombstone = (a) =>
  !a.deletedAt || Date.now() - Date.parse(a.deletedAt) < TOMBSTONE_TTL_MS;

const gcTombstones = (travel) => ({
  ...travel,
  activities: travel.activities.filter(freshTombstone),
  attachments: travel.attachments.filter(freshTombstone),
});

const envelope = (travel, revision) => ({
  app: 'travel-42uy',
  schemaVersion: SCHEMA,
  travelId: travel.id,
  revision,
  updatedAt: nowIso(),
  updatedBy: store.actor ?? null,
  travel: { ...gcTombstones(travel), revision },
});

// Un colaborador puede editar el archivo fuera de la app: validar siempre.
export const validateRemote = (data, expectedTravelId) => {
  const bad = (why) => new SyncError('INVALID_REMOTE', `Archivo remoto inválido: ${why}`);
  if (!data || typeof data !== 'object') throw bad('no es un objeto');
  if (data.app !== 'travel-42uy') throw bad('no es de esta app');
  if (data.schemaVersion !== SCHEMA) throw bad(`schema ${data.schemaVersion} no soportado`);
  if (!Number.isInteger(data.revision) || data.revision < 0) throw bad('revision');
  const t = data.travel;
  if (!t || typeof t !== 'object' || typeof t.id !== 'string') throw bad('travel');
  if (expectedTravelId && t.id !== expectedTravelId) throw bad('es otro viaje');
  const m = t.meta;
  if (!m || typeof m.name !== 'string' || typeof m.start !== 'string' || typeof m.end !== 'string') throw bad('meta');
  if (!m.base || typeof m.base.lat !== 'number' || typeof m.base.lon !== 'number') throw bad('base');
  if (!Array.isArray(t.activities) || t.activities.some((a) => !a || typeof a.id !== 'string')) throw bad('activities');
  if (!Array.isArray(t.attachments)) t.attachments = [];
  if (t.attachments.some((a) => !a || typeof a.id !== 'string')) throw bad('attachments');
  return { revision: data.revision, travel: t };
};

// ---------- replay de comandos pendientes ----------

const isRemoveCmd = (type) =>
  type === 'REMOVE_ACTIVITY' || type === 'REMOVE_ACTIVITIES' || type === 'REMOVE_ATTACHMENT';

const cmdLabel = (cmd) => {
  const p = cmd.payload;
  switch (cmd.type) {
    case 'UPDATE_ACTIVITY': return p.to.title ?? p.id;
    case 'REMOVE_ACTIVITY': return p.activity.title ?? p.activity.id;
    case 'REMOVE_ACTIVITIES': return `${p.activities.length} paradas`;
    case 'ADD_ATTACHMENT':
    case 'REMOVE_ATTACHMENT': return p.attachment.name ?? p.attachment.id;
    case 'SET_ACTIVITIES': return 'todo el itinerario';
    case 'UPDATE_VACATION_META': return 'datos del viaje';
    default: return cmd.type;
  }
};

const findClashes = (travel, cmd) => {
  const clashes = [];
  for (const t of conflictTargets(cmd)) {
    if (t.id === 'meta') {
      if ((travel.meta.rev ?? 0) !== t.baseRev) clashes.push({ target: t, current: travel.meta });
      continue;
    }
    const list = t.col === 'attachments' ? travel.attachments : travel.activities;
    const current = list.find((a) => a.id === t.id) ?? null;
    if (!current) {
      // Borrado duro remoto (GC de tombstones): borrar algo que ya no está
      // da el mismo resultado — no es conflicto para comandos de borrado.
      if (!isRemoveCmd(cmd.type)) clashes.push({ target: t, current: null });
    } else if ((current.rev ?? 0) !== t.baseRev) {
      // Ídem: tombstone remoto + borrado local convergen solos.
      if (!(isRemoveCmd(cmd.type) && current.deletedAt)) clashes.push({ target: t, current });
    }
  }
  return clashes;
};

const forceApply = (travel, cmd) => {
  // "Quedarme con lo mío" sobre una entidad borrada remotamente: la entidad
  // ya no existe en el snapshot, un UPDATE mapearía sobre nada. Reinsertar
  // la base local primero para que apply() la encuentre.
  if (cmd.type === 'UPDATE_ACTIVITY' && !travel.activities.some((a) => a.id === cmd.payload.id)) {
    travel.activities = [...travel.activities, cmd.payload.from];
  }
  COMMANDS[cmd.type].apply(travel, cmd.payload, cmd);
};

const replay = (remoteTravel, pending, resolutions) => {
  const travel = structuredClone(remoteTravel);
  const unresolved = [];
  for (const cmd of pending) {
    const clashes = findClashes(travel, cmd);
    if (!clashes.length) {
      COMMANDS[cmd.type].apply(travel, cmd.payload, cmd);
      continue;
    }
    const choice = resolutions?.[cmd.cmdId];
    if (choice === 'mine') {
      forceApply(travel, cmd);
    } else if (choice === 'theirs') {
      // descartado: gana el estado remoto
    } else {
      const c = clashes[0];
      unresolved.push({
        cmdId: cmd.cmdId,
        type: cmd.type,
        label: cmdLabel(cmd),
        theirs: {
          updatedBy: c.current?.updatedBy ?? null,
          updatedAt: c.current?.updatedAt ?? null,
          deleted: Boolean(c.current?.deletedAt),
          missing: c.current === null,
        },
      });
    }
  }
  return { travel, unresolved };
};

// ---------- adjuntos pendientes de subir ----------

const uploadPendingAttachments = async (rec, travel) => {
  const uploaded = {};
  for (const att of travel.attachments) {
    if (att.driveFileId || att.deletedAt) continue;
    const blob = await getAttachmentBlob(att.id);
    if (!blob) continue;
    const file = await drive.uploadFile({
      name: att.name,
      parentId: rec.driveFolderId,
      blob,
      mimeType: att.mimeType,
    });
    att.driveFileId = file.id;
    uploaded[att.id] = file.id;
  }
  return uploaded;
};

// Adjuntos borrados → papelera de Drive. Corre al sincronizar, nunca al
// borrar: el tombstone es la verdad y el archivo va a la papelera (no borrado
// definitivo) para que deshacer siga funcionando — trashed se sigue leyendo
// por id y, si el adjunto revive, la próxima sincronización lo restaura.
// Drive solo deja mover a la papelera al dueño del archivo (quien lo subió):
// cada cliente intenta una vez por tombstone y lo anota en el sync record;
// el dueño real lo concreta cuando adopta el tombstone. La purga de la
// papelera (~30 días) coincide con el TTL de tombstones.
const syncAttachmentTrash = async (travelId, rec, attachments) => {
  const marks = new Set(rec.trashedAttachments ?? []);
  const before = [...marks].sort().join(',');
  for (const att of attachments) {
    if (!att.driveFileId) continue;
    const wantTrash = Boolean(att.deletedAt);
    if (wantTrash === marks.has(att.id)) continue;
    try {
      await drive.setTrashed(att.driveFileId, wantTrash);
      wantTrash ? marks.add(att.id) : marks.delete(att.id);
    } catch (err) {
      // 403 (no soy dueño) / 404 (ya no existe): no hay nada más que hacer
      // desde esta cuenta. Cualquier otro error se reintenta al próximo sync.
      if (err?.code !== 'NO_ACCESS') continue;
      wantTrash ? marks.add(att.id) : marks.delete(att.id);
    }
  }
  const ids = new Set(attachments.map((a) => a.id));
  for (const id of [...marks]) if (!ids.has(id)) marks.delete(id); // tombstones GC'd
  if ([...marks].sort().join(',') !== before) {
    rec.trashedAttachments = [...marks];
    store.setSyncRecord(travelId, rec);
  }
};

// ---------- operaciones ----------

const uploadState = async (rec, travel, revision) => {
  const uploadedIds = await uploadPendingAttachments(rec, travel);
  const metadata = await drive.updateJsonFile({ fileId: rec.driveFileId, data: envelope(travel, revision) });
  return { metadata, travel, uploadedIds };
};

const consume = (travelId, rec, count, revision, driveVersion) => {
  rec.pending.splice(0, count);
  rec.baseRevision = revision;
  rec.baseDriveVersion = String(driveVersion);
  rec.lastSyncAt = nowIso();
  store.setSyncRecord(travelId, rec);
};

// Comparte el viaje activo: crea carpeta + travel.json y registra el sync
// record. La carpeta es la unidad de permisos (los adjuntos viven adentro).
export const shareTravel = async (travelId) => {
  const travel = localTravel(travelId);
  if (!travel) throw new SyncError('NOT_FOUND', 'Ese viaje no existe.');
  if (store.isShared(travelId)) return store.syncRecord(travelId);
  const folder = await drive.createFolder(`Travel — ${travel.meta.name}`);
  const revision = 1;
  const file = await drive.createJsonFile({
    name: 'travel.json',
    parentId: folder.id,
    data: envelope(structuredClone(travel), revision),
  });
  const rec = {
    driveFolderId: folder.id,
    driveFileId: file.id,
    baseRevision: revision,
    baseDriveVersion: String(file.version),
    lastSyncAt: nowIso(),
    pending: [],
    // Con writersCanShare:false solo el dueño puede invitar; la UI de
    // compartir se esconde para los demás. Drive lo re-verifica igual.
    canShare: true,
  };
  store.setSyncRecord(travelId, rec);
  return rec;
};

// Deja de sincronizar localmente. No toca permisos de Drive: el dueño puede
// borrar la carpeta desde Drive si quiere revocar de verdad.
export const unshareTravel = (travelId) => store.removeSyncRecord(travelId);

// Sincronización unificada: pull, push o merge según el estado de ambos
// lados. Con conflictos devuelve { status: 'conflicts', conflicts } y el
// llamador vuelve a invocar con resolutions = { [cmdId]: 'mine'|'theirs' }.
export const syncTravel = async (travelId, { resolutions = null, _retried = false } = {}) => {
  const rec = store.syncRecord(travelId);
  if (!rec) throw new SyncError('NOT_SHARED');
  const local = localTravel(travelId);
  if (!local) throw new SyncError('NOT_FOUND', 'Ese viaje no existe.');

  // Los comandos que lleguen durante los await quedan después de este corte
  // y sobreviven en pending para la próxima sincronización.
  const pendingCount = rec.pending.length;

  const head = await drive.getMetadata(rec.driveFileId);
  if (head.trashed) throw new SyncError('NO_ACCESS', 'El viaje compartido ya no existe en Drive.');
  // Refrescar el flag de dueño (capabilities es por usuario).
  const canShare = Boolean(head.capabilities?.canShare);
  if (rec.canShare !== canShare) {
    rec.canShare = canShare;
    store.setSyncRecord(travelId, rec);
  }
  const remoteChanged = String(head.version) !== String(rec.baseDriveVersion);
  const hasNewAttachments = local.attachments.some((a) => !a.driveFileId && !a.deletedAt);

  if (!pendingCount && !hasNewAttachments && !remoteChanged) {
    // Reintento de papelera que quedó pendiente (p. ej. corte de red).
    await syncAttachmentTrash(travelId, rec, local.attachments);
    return { status: 'clean' };
  }

  if (!pendingCount && remoteChanged) {
    const { metadata, data } = await drive.readJsonFile(rec.driveFileId);
    const remote = validateRemote(data, travelId);
    store.replaceTravel(travelId, remote.travel);
    consume(travelId, rec, 0, remote.revision, metadata.version);
    await syncAttachmentTrash(travelId, rec, remote.travel.attachments);
    return { status: 'updated' };
  }

  if (!remoteChanged) {
    const travel = structuredClone(local);
    const revision = (rec.baseRevision ?? 0) + 1;
    const { metadata, uploadedIds } = await uploadState(rec, travel, revision);
    consume(travelId, rec, pendingCount, revision, metadata.version);
    // El clon subido tiene los driveFileId nuevos; reflejarlos en el estado
    // local sin tocar el historial de deshacer.
    if (Object.keys(uploadedIds).length) store.patchAttachmentDriveIds(travelId, uploadedIds);
    await syncAttachmentTrash(travelId, rec, travel.attachments);
    return { status: 'pushed' };
  }

  // Cambios en ambos lados: replay de pendientes sobre el snapshot remoto.
  const { metadata, data } = await drive.readJsonFile(rec.driveFileId);
  const remote = validateRemote(data, travelId);
  const { travel: merged, unresolved } = replay(remote.travel, rec.pending.slice(0, pendingCount), resolutions);
  if (unresolved.length) return { status: 'conflicts', conflicts: unresolved };

  // Última verificación de carrera antes de escribir. No es atómico (dos
  // clientes pueden pasar el chequeo casi a la vez); aceptable para un grupo
  // chico con edición esporádica.
  const head2 = await drive.getMetadata(rec.driveFileId);
  if (String(head2.version) !== String(metadata.version)) {
    if (_retried) throw new SyncError('BUSY', 'Otra persona está guardando ahora mismo. Probá de nuevo.');
    return syncTravel(travelId, { resolutions, _retried: true });
  }

  const revision = remote.revision + 1;
  const { metadata: uploadedMeta } = await uploadState(rec, merged, revision);
  store.replaceTravel(travelId, merged);
  consume(travelId, rec, pendingCount, revision, uploadedMeta.version);
  await syncAttachmentTrash(travelId, rec, merged.attachments);
  return { status: 'merged' };
};

// ---------- flujo de invitación ----------

export const joinTravel = async (fileId) => {
  const { metadata, data } = await drive.readJsonFile(fileId);
  const remote = validateRemote(data, null);
  const rec = {
    driveFolderId: metadata.parents?.[0] ?? null,
    driveFileId: metadata.id,
    baseRevision: remote.revision,
    baseDriveVersion: String(metadata.version),
    lastSyncAt: nowIso(),
    pending: [],
    canShare: Boolean(metadata.capabilities?.canShare),
  };
  store.adoptTravel(remote.travel, rec);
  return remote.travel;
};

// Con drive.file un invitado no puede leer por ID hasta elegir el recurso en
// el Picker; este es el camino de recuperación cuando joinTravel da 403/404.
export const joinViaPicker = async () => {
  const doc = await drive.pickSharedFolder();
  if (!doc) return null;
  const children = await drive.listChildren(doc.id, { name: 'travel.json' });
  const file = children.find((f) => f.name === 'travel.json');
  if (!file) throw new SyncError('NOT_A_TRAVEL', 'Esa carpeta no tiene un viaje de esta app.');
  return joinTravel(file.id);
};

export const validInviteFileId = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(id);
