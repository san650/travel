// UI de compartir/sincronizar. Google Drive es el backend invisible: acá se
// habla de «viaje compartido» y «sincronizar»; la palabra Drive solo aparece
// en el momento de conectar la cuenta. Modelo manual: se sincroniza al tocar
// el chip, al compartir y al unirse — nunca en segundo plano.

import { store } from './store.js';
import * as sync from './sync.js';
import * as drive from './drive.js';
import { askConfirm } from './confirm.js';
import { makeCommand } from './commands.js';
import { getAttachmentBlob, putAttachmentBlob } from './db.js';

const $ = (id) => document.getElementById(id);
const cloneTpl = (id) => $(id).content.firstElementChild.cloneNode(true);
const slot = (node, name) => node.querySelector(`[data-slot="${name}"]`);

let els = {};
let syncing = false;
let flashTimer = 0;
let joinFileId = null;
let joinName = '';
let joinMode = 'direct'; // 'direct' | 'picker'

// El flujo de auth por redirección (fallback en la PWA instalada de iOS)
// recarga la página: la acción en curso se anota en sessionStorage antes de
// autorizar y se retoma al volver con el token en el fragmento.
const PENDING_ACTION = 'travel42uy-pending-action';
const rememberAction = (a) => { try { sessionStorage.setItem(PENDING_ACTION, JSON.stringify(a)); } catch {} };
const clearAction = () => { try { sessionStorage.removeItem(PENDING_ACTION); } catch {} };
const takeAction = () => {
  try {
    const raw = sessionStorage.getItem(PENDING_ACTION);
    sessionStorage.removeItem(PENDING_ACTION);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

// ---------- chip de estado ----------

const updateChip = () => {
  const v = store.activeVacation();
  if (!v || !store.isShared(v.id)) { els.chip.hidden = true; return; }
  els.chip.hidden = false;
  els.chip.classList.remove('sync-chip--error');
  if (syncing) {
    els.chip.textContent = 'Sincronizando…';
    els.chip.disabled = true;
    els.chip.classList.remove('sync-chip--dirty');
    return;
  }
  els.chip.disabled = false;
  const n = store.pendingCount(v.id);
  els.chip.classList.toggle('sync-chip--dirty', n > 0);
  els.chip.textContent = n > 0 ? (n === 1 ? '1 cambio sin sincronizar' : `${n} cambios sin sincronizar`) : 'Sincronizado';
};

const flash = (text, isError = false) => {
  clearTimeout(flashTimer);
  els.chip.hidden = false;
  els.chip.textContent = text;
  els.chip.classList.toggle('sync-chip--error', isError);
  flashTimer = setTimeout(updateChip, 2600);
};

// ---------- configuración de Google (primera vez) ----------

const ensureConfigured = async ({ force = false } = {}) => {
  const cfg = await drive.loadConfig();
  if (!force && drive.isConfigured()) return;
  await new Promise((resolve, reject) => {
    const form = $('form-setup');
    const error = $('setup-error');
    form.elements.clientId.value = cfg.clientId || '';
    form.elements.apiKey.value = cfg.apiKey || '';
    form.elements.appId.value = cfg.appId || '';
    error.hidden = true;
    const onSubmit = async (e) => {
      e.preventDefault();
      const clientId = form.elements.clientId.value.trim();
      if (!clientId.endsWith('.apps.googleusercontent.com')) {
        error.textContent = 'Ese Client ID no parece válido: termina en .apps.googleusercontent.com.';
        error.hidden = false;
        return;
      }
      await drive.setConfig({
        clientId,
        apiKey: form.elements.apiKey.value,
        appId: form.elements.appId.value,
      });
      cleanup();
      els.dlgSetup.close();
      resolve();
    };
    const onClose = () => { cleanup(); reject(new Error('cancelled')); };
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      els.dlgSetup.removeEventListener('close', onClose);
    };
    form.addEventListener('submit', onSubmit);
    els.dlgSetup.addEventListener('close', onClose);
    els.dlgSetup.showModal();
  });
};

// ---------- nombre local (updatedBy) ----------

const ensureActor = () => {
  if (store.actor) return Promise.resolve(store.actor);
  return new Promise((resolve, reject) => {
    const form = $('form-name');
    const onSubmit = (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      if (!name) return;
      store.setActor(name);
      cleanup();
      els.dlgName.close();
      resolve(name);
    };
    const onClose = () => { cleanup(); reject(new Error('cancelled')); };
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      els.dlgName.removeEventListener('close', onClose);
    };
    form.addEventListener('submit', onSubmit);
    els.dlgName.addEventListener('close', onClose);
    form.reset();
    els.dlgName.showModal();
  });
};

// ---------- conflictos ----------

const openConflicts = (conflicts) =>
  new Promise((resolve) => {
    const choices = new Map();
    const list = $('conflict-list');
    const apply = $('btn-conf-apply');
    apply.disabled = true;

    list.replaceChildren(...conflicts.map((c) => {
      const li = cloneTpl('tpl-conflict');
      slot(li, 'name').textContent = c.label;
      const who = c.theirs.updatedBy || 'Alguien';
      slot(li, 'sub').textContent = c.theirs.missing || c.theirs.deleted
        ? `${who} la borró`
        : `${who} también la cambió`;
      const mineBtn = slot(li, 'mine');
      const theirsBtn = slot(li, 'theirs');
      const choose = (choice) => {
        choices.set(c.cmdId, choice);
        mineBtn.classList.toggle('seg__btn--active', choice === 'mine');
        theirsBtn.classList.toggle('seg__btn--active', choice === 'theirs');
        apply.disabled = choices.size < conflicts.length;
      };
      mineBtn.onclick = () => choose('mine');
      theirsBtn.onclick = () => choose('theirs');
      return li;
    }));

    const done = (value) => {
      apply.onclick = null;
      $('btn-conf-cancel').onclick = null;
      els.dlgConflicts.onclose = null;
      if (els.dlgConflicts.open) els.dlgConflicts.close();
      resolve(value);
    };
    apply.onclick = () => done(Object.fromEntries(choices));
    $('btn-conf-cancel').onclick = () => done(null);
    els.dlgConflicts.onclose = () => done(null);
    els.dlgConflicts.showModal();
  });

// ---------- sincronizar ----------

const statusLabel = {
  clean: 'Todo al día',
  updated: 'Viaje actualizado',
  pushed: 'Cambios guardados',
  merged: 'Cambios combinados',
};

const errorLabel = (err) => {
  if (err.code === 'OFFLINE') return 'Sin conexión';
  if (err.code === 'NOT_CONFIGURED') return 'Falta configurar Google';
  if (err.code === 'AUTH_FAILED') return 'No se pudo conectar';
  if (err.code === 'NO_ACCESS') return 'Perdiste acceso al viaje';
  if (err.code === 'BUSY') return 'Ocupado, probá de nuevo';
  return 'Error al sincronizar';
};

export const runSync = async () => {
  const v = store.activeVacation();
  if (!v || !store.isShared(v.id) || syncing) return;
  syncing = true;
  updateChip();
  rememberAction({ action: 'sync', travelId: v.id });
  try {
    let resolutions = null;
    for (;;) {
      const result = await sync.syncTravel(v.id, { resolutions });
      if (result.status !== 'conflicts') {
        flash(statusLabel[result.status] ?? 'Sincronizado');
        break;
      }
      const chosen = await openConflicts(result.conflicts);
      if (!chosen) { updateChip(); break; }
      resolutions = { ...resolutions, ...chosen };
    }
  } catch (err) {
    console.error('sync failed', err);
    if (err.code === 'NO_ACCESS') {
      // El dueño borró la carpeta, o te quitaron el permiso — por API son
      // indistinguibles. Los datos locales están intactos: ofrecer quedarse
      // con el viaje como local en vez de dejar el sync fallando para
      // siempre. «Ahora no» cubre el caso de un permiso por restaurarse.
      const keep = await askConfirm({
        title: 'No se pudo acceder al viaje compartido',
        body: 'Ya no existe o perdiste el acceso. Tus datos siguen en este ' +
          'dispositivo: podés conservarlo como un viaje local (deja de sincronizar).',
        acceptLabel: 'Conservar como local',
      });
      if (keep) {
        sync.unshareTravel(v.id);
        flash('Ahora es un viaje local');
      } else {
        flash(errorLabel(err), true);
      }
    } else {
      flash(errorLabel(err), true);
    }
  } finally {
    clearAction();
    syncing = false;
    setTimeout(updateChip, 2600);
  }
};

// ---------- diálogo de compartir ----------

// La invitación es un ARCHIVO (<viaje>.travel.invite), no un enlace: en
// iPhone los links jamás abren la PWA instalada, así que un único flujo
// archivo → share sheet → «Unirse con una invitación» sirve para todos.
// Lleva el fileId (una dirección, no una llave: Drive valida los permisos
// de la cuenta que lo abre) más la config pública de la app, para que el
// invitado no configure nada. Son identificadores públicos, no secretos.
const INVITE_VERSION = 1;

const slugName = (s) =>
  s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'viaje';

const shareInviteFile = async () => {
  const v = store.activeVacation();
  const rec = v && store.syncRecord(v.id);
  if (!rec) return;
  const cfg = drive.getConfig();
  const invite = {
    app: 'travel-42uy',
    kind: 'invite',
    version: INVITE_VERSION,
    name: v.meta.name,
    fileId: rec.driveFileId,
    config: { clientId: cfg.clientId, apiKey: cfg.apiKey, appId: cfg.appId },
  };
  const filename = `${slugName(v.meta.name)}.travel.invite`;
  const blob = new Blob([JSON.stringify(invite, null, 2)], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const showShareError = (err) => {
  console.error(err);
  els.shareError.textContent = err?.message?.startsWith('Google Drive')
    ? 'No se pudo hablar con el servidor. Probá de nuevo.'
    : (err?.message || 'Algo salió mal.');
  els.shareError.hidden = false;
};

const renderMembers = async (rec, canShare) => {
  els.memberList.replaceChildren();
  try {
    const perms = await drive.listPermissions(rec.driveFolderId ?? rec.driveFileId);
    els.memberList.replaceChildren(...perms.filter((p) => !p.deleted).map((p) => {
      const li = cloneTpl('tpl-member');
      slot(li, 'name').textContent = p.displayName || p.emailAddress || '—';
      slot(li, 'role').textContent =
        p.role === 'owner' ? 'dueño' : p.role === 'writer' ? 'edita' : 'mira';
      const btn = slot(li, 'remove');
      if (p.role === 'owner' || !canShare) btn.hidden = true;
      btn.onclick = async () => {
        const ok = await askConfirm({
          title: `¿Quitar a «${p.displayName || p.emailAddress}»?`,
          body: 'Pierde el acceso al viaje compartido.',
          acceptLabel: 'Quitar',
        });
        if (!ok) return;
        try {
          await drive.removePermission({
            fileId: rec.driveFolderId ?? rec.driveFileId,
            permissionId: p.id,
          });
          renderMembers(rec);
        } catch (err) { showShareError(err); }
      };
      return li;
    }));
  } catch {
    // Sin permiso para listar (no es el dueño): la lista queda vacía.
  }
};

const renderShareDialog = () => {
  const v = store.activeVacation();
  if (!v) return;
  const rec = store.syncRecord(v.id);
  els.shareError.hidden = true;
  els.shareBtnStart.textContent = 'Compartir este viaje';
  $('share-off').hidden = Boolean(rec);
  $('share-on').hidden = !rec;
  if (!rec) return;
  // Con writersCanShare:false solo el dueño puede invitar: sin la capacidad,
  // el link y el formulario serían botones que solo pueden fallar.
  const canShare = rec.canShare !== false;
  $('share-owner').hidden = !canShare;
  $('share-member-hint').hidden = canShare;
  const when = rec.lastSyncAt
    ? new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(rec.lastSyncAt))
    : 'nunca';
  $('share-status').textContent = `Última sincronización: ${when}.`;
  renderMembers(rec, canShare);
};

const openShareDialog = () => {
  renderShareDialog();
  els.dlgShare.showModal();
};

const shareNow = async () => {
  const v = store.activeVacation();
  if (!v) return;
  await drive.loadConfig();
  const hadSetup = drive.isConfigured() && Boolean(store.actor);
  try {
    await ensureConfigured();
    await ensureActor();
  } catch { return; }
  if (!hadSetup && !drive.hasToken()) {
    // Los modales de primera vez consumieron la activación del gesto y el
    // popup de Google sería bloqueado ("failed to open popup"): pedir un
    // tap fresco con la etiqueta correcta.
    els.shareBtnStart.textContent = 'Conectar con Google';
    return;
  }
  els.shareBtnStart.disabled = true;
  els.shareBtnStart.textContent = 'Conectando…';
  rememberAction({ action: 'share', travelId: v.id });
  try {
    if (!drive.hasToken()) await drive.authorize({ prompt: 'consent' });
    await sync.shareTravel(v.id);
    renderShareDialog();
    updateChip();
  } catch (err) {
    showShareError(err);
  } finally {
    clearAction();
    els.shareBtnStart.disabled = false;
    els.shareBtnStart.textContent = 'Compartir este viaje';
  }
};

const addMember = async (e) => {
  e.preventDefault();
  const v = store.activeVacation();
  const rec = v && store.syncRecord(v.id);
  if (!rec) return;
  const form = els.memberForm;
  const email = form.elements.email.value.trim();
  if (!email) return;
  els.shareError.hidden = true;
  try {
    await drive.shareWith({
      fileId: rec.driveFolderId ?? rec.driveFileId,
      emailAddress: email,
      role: form.elements.role.value,
    });
    form.reset();
    renderMembers(rec);
  } catch (err) { showShareError(err); }
};

const stopSharing = async () => {
  const v = store.activeVacation();
  if (!v) return;
  const ok = await askConfirm({
    title: '¿Dejar de sincronizar?',
    body: 'El viaje queda solo en este dispositivo. La copia compartida no se borra: manejala desde tu Drive.',
    acceptLabel: 'Dejar de sincronizar',
  });
  if (!ok) return;
  sync.unshareTravel(v.id);
  els.dlgShare.close();
  updateChip();
};

// ---------- adjuntos ----------
// Metadata en travel.attachments (comandos, sincroniza); binario local en
// IndexedDB desde el momento de adjuntar; sube recién al sincronizar. Otros
// miembros lo descargan la primera vez que lo abren y queda cacheado.

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const notice = (title, body) => askConfirm({ title, body, acceptLabel: 'OK' });

export const attachFile = async (activityId, file) => {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    notice('Archivo muy grande', 'Hasta 15 MB por adjunto.');
    return;
  }
  const id = crypto.randomUUID();
  try {
    await putAttachmentBlob(id, file);
  } catch (err) {
    console.error('attachment store failed', err);
    notice('No se pudo guardar', 'No hay lugar para guardar el adjunto en este dispositivo.');
    return;
  }
  store.dispatch(makeCommand('ADD_ATTACHMENT', {
    attachment: {
      id,
      activityId,
      name: file.name || 'adjunto',
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      driveFileId: null,
    },
  }));
};

export const openAttachment = async (att) => {
  let blob = null;
  try { blob = await getAttachmentBlob(att.id); } catch {}
  if (!blob) {
    if (!att.driveFileId) {
      notice('Todavía no sincronizado', 'Quien lo adjuntó tiene que sincronizar antes de que puedas verlo.');
      return;
    }
    try {
      flash('Descargando…');
      blob = await drive.downloadFile(att.driveFileId);
      await putAttachmentBlob(att.id, blob).catch(() => {});
      updateChip();
    } catch (err) {
      console.error('attachment download failed', err);
      notice(
        err.code === 'OFFLINE' ? 'Sin conexión' : 'No se pudo descargar',
        err.code === 'OFFLINE'
          ? 'Este adjunto va a estar disponible sin conexión después de abrirlo una vez.'
          : 'Probá sincronizar y abrirlo de nuevo.',
      );
      return;
    }
  }
  if ((att.mimeType || '').startsWith('image/')) {
    const url = URL.createObjectURL(blob);
    $('lightbox-img').src = url;
    $('dlg-photo').showModal();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  // PDFs y otros: en la PWA instalada de iOS, blob: + _blank es poco fiable
  // y no ofrece guardar; el share sheet nativo («Abrir en Archivos…») sí.
  const file = new File([blob], att.name || 'adjunto', {
    type: att.mimeType || 'application/octet-stream',
  });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // canceló el share sheet
      // p. ej. gesto expirado tras la descarga: caer al ancla
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

export const removeAttachment = async (att) => {
  const ok = await askConfirm({
    title: `¿Borrar «${att.name}»?`,
    body: 'Podés deshacerlo con ↶.',
  });
  if (!ok) return;
  store.dispatch(makeCommand('REMOVE_ATTACHMENT', { attachment: att }));
};

// ---------- unirse por invitación ----------

const showJoinError = (message) => {
  $('join-error').textContent = message;
  $('join-error').hidden = false;
};

const joinGo = async () => {
  $('join-error').hidden = true;
  await drive.loadConfig();
  const hadSetup = drive.isConfigured() && Boolean(store.actor);
  try {
    await ensureConfigured();
    await ensureActor();
  } catch { return; }
  if (!hadSetup && !drive.hasToken()) {
    // Ídem shareNow: los modales consumieron la activación; tap fresco.
    showJoinError('Listo. Tocá «Conectar y abrir» de nuevo para continuar.');
    return;
  }
  els.joinGoBtn.disabled = true;
  rememberAction({ action: 'join', fileId: joinFileId, name: joinName, mode: joinMode });
  try {
    if (!drive.hasToken()) await drive.authorize({ prompt: 'consent' });
    const travel = joinMode === 'picker'
      ? await sync.joinViaPicker()
      : await sync.joinTravel(joinFileId);
    if (!travel) return; // canceló el selector
    els.dlgJoin.close();
    flash(`Te uniste a «${travel.meta.name}»`);
  } catch (err) {
    console.error('join failed', err);
    if (err.code === 'NO_ACCESS' && joinMode === 'direct') {
      // drive.file: la app no ve el archivo hasta que el usuario elige la
      // carpeta compartida en el selector de Google.
      joinMode = 'picker';
      $('join-picker').hidden = false;
      els.joinGoBtn.textContent = 'Elegir carpeta';
    } else if (err.code === 'NOT_CONFIGURED') {
      // Faltan API key / número de proyecto para el selector.
      try {
        await ensureConfigured({ force: true });
        showJoinError('Listo. Tocá de nuevo para continuar.');
      } catch {}
    } else if (err.code === 'OFFLINE') {
      showJoinError('Sin conexión. Abrí el enlace de nuevo cuando tengas internet.');
    } else if (err.code === 'NOT_A_TRAVEL' || err.code === 'INVALID_REMOTE') {
      showJoinError('Eso no parece un viaje de esta app.');
    } else {
      showJoinError('No se pudo abrir la invitación. Revisá que entraste con la cuenta invitada.');
    }
  } finally {
    clearAction();
    els.joinGoBtn.disabled = false;
  }
};

// Al volver de una autorización por redirección, retomar lo que el usuario
// estaba haciendo (el token ya fue adoptado por drive.adoptRedirectToken).
const resumeAction = async (p) => {
  if (p.action === 'sync' && store.activeVacation()?.id === p.travelId) {
    runSync();
  } else if (p.action === 'share' && p.travelId) {
    try {
      await sync.shareTravel(p.travelId);
      updateChip();
      openShareDialog();
    } catch (err) {
      console.error('share resume failed', err);
      flash('Error al compartir', true);
    }
  } else if (p.action === 'join' && p.fileId) {
    openJoinDialog(p.fileId, p.name);
    joinMode = p.mode === 'picker' ? 'picker' : 'direct';
    joinGo();
  }
};

// Config pública embebida en la invitación: se adopta solo si este
// dispositivo todavía no tiene una propia.
const adoptInviteConfig = async (cfg) => {
  const clientId = cfg?.clientId;
  if (!clientId) return;
  await drive.loadConfig();
  if (!drive.isConfigured() && clientId.endsWith('.apps.googleusercontent.com')) {
    await drive.setConfig({
      clientId,
      apiKey: cfg.apiKey ?? '',
      appId: cfg.appId ?? '',
    });
  }
};

const openJoinDialog = (fileId, name) => {
  joinFileId = fileId;
  joinName = name || '';
  joinMode = 'direct';
  $('dlg-join-title').textContent = name ? `Te invitaron a «${name}»` : 'Te invitaron a un viaje';
  $('join-picker').hidden = true;
  $('join-error').hidden = true;
  els.joinGoBtn.textContent = 'Conectar y abrir';
  els.dlgJoin.showModal();
};

const inviteFileChosen = async (fileObj) => {
  let data = null;
  try { data = JSON.parse(await fileObj.text()); } catch {}
  const valid = data &&
    data.app === 'travel-42uy' &&
    data.kind === 'invite' &&
    sync.validInviteFileId(data.fileId);
  if (!valid) {
    notice('Invitación inválida', 'Ese archivo no es una invitación de esta app.');
    return;
  }
  await adoptInviteConfig(data.config);
  openJoinDialog(data.fileId, typeof data.name === 'string' ? data.name : '');
};

// ---------- arranque ----------

export const initShare = () => {
  els = {
    chip: $('sync-chip'),
    dlgShare: $('dlg-share'),
    dlgConflicts: $('dlg-conflicts'),
    dlgName: $('dlg-name'),
    dlgJoin: $('dlg-join'),
    dlgSetup: $('dlg-setup'),
    shareError: $('share-error'),
    shareBtnStart: $('btn-share-start'),
    memberForm: $('form-member'),
    memberList: $('member-list'),
    joinGoBtn: $('btn-join-go'),
  };

  els.chip.onclick = () => runSync();
  $('btn-share').onclick = () => { $('dlg-tools').close(); openShareDialog(); };
  els.shareBtnStart.onclick = () => shareNow();
  $('btn-share-cancel').onclick = () => els.dlgShare.close();
  $('btn-share-close').onclick = () => els.dlgShare.close();
  $('btn-share-stop').onclick = () => stopSharing();
  $('btn-share-file').onclick = () => shareInviteFile();
  els.memberForm.addEventListener('submit', addMember);
  els.dlgShare.onclick = (ev) => { if (ev.target === els.dlgShare) els.dlgShare.close(); };
  $('btn-setup-edit').onclick = () => ensureConfigured({ force: true }).catch(() => {});
  $('btn-setup-cancel').onclick = () => els.dlgSetup.close();

  els.joinGoBtn.onclick = () => joinGo();
  $('btn-join-cancel').onclick = () => els.dlgJoin.close();

  $('btn-vac-join').onclick = () => {
    $('dlg-vacations').close();
    $('file-invite').click();
  };
  $('file-invite').onchange = () => {
    const input = $('file-invite');
    const file = input.files?.[0];
    input.value = '';
    if (file) inviteFileChosen(file);
  };

  // Aviso al salir con cambios sin sincronizar (mejor esfuerzo; iOS no
  // siempre lo dispara — el chip queda como recordatorio persistente).
  window.addEventListener('beforeunload', (e) => {
    const v = store.activeVacation();
    if (v && store.isShared(v.id) && store.pendingCount(v.id) > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  store.subscribe(updateChip);
  updateChip();
  drive.loadConfig();

  // ¿Venimos de una redirección de autorización (fallback de la PWA iOS)?
  const auth = drive.adoptRedirectToken();
  const pending = auth ? takeAction() : null;
  if (auth?.ok && pending) {
    resumeAction(pending);
  } else if (auth && !auth.ok) {
    clearAction();
    flash(auth.error === 'access_denied' ? 'Conexión cancelada' : 'No se pudo conectar', true);
  }
};
