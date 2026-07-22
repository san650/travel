// UI de compartir/sincronizar. Google Drive es el backend invisible: acá se
// habla de «viaje compartido» y «sincronizar»; la palabra Drive solo aparece
// en el momento de conectar la cuenta. Modelo manual: se sincroniza al tocar
// el chip, al compartir y al unirse — nunca en segundo plano.

import { store } from './store.js';
import * as sync from './sync.js';
import * as drive from './drive.js';
import { askConfirm } from './confirm.js';

const $ = (id) => document.getElementById(id);
const cloneTpl = (id) => $(id).content.firstElementChild.cloneNode(true);
const slot = (node, name) => node.querySelector(`[data-slot="${name}"]`);

let els = {};
let syncing = false;
let flashTimer = 0;
let joinFileId = null;
let joinMode = 'direct'; // 'direct' | 'picker'

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
  const n = store.pendingCount(v.id) + v.attachments.filter((a) => !a.driveFileId && !a.deletedAt).length;
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
    flash(errorLabel(err), true);
  } finally {
    syncing = false;
    setTimeout(updateChip, 2600);
  }
};

// ---------- diálogo de compartir ----------

const inviteUrl = (rec) =>
  `${location.origin}${location.pathname}?join=${rec.driveFileId}`;

const showShareError = (err) => {
  console.error(err);
  els.shareError.textContent = err?.message?.startsWith('Google Drive')
    ? 'No se pudo hablar con el servidor. Probá de nuevo.'
    : (err?.message || 'Algo salió mal.');
  els.shareError.hidden = false;
};

const renderMembers = async (rec) => {
  els.memberList.replaceChildren();
  try {
    const perms = await drive.listPermissions(rec.driveFolderId ?? rec.driveFileId);
    els.memberList.replaceChildren(...perms.filter((p) => !p.deleted).map((p) => {
      const li = cloneTpl('tpl-member');
      slot(li, 'name').textContent = p.displayName || p.emailAddress || '—';
      slot(li, 'role').textContent =
        p.role === 'owner' ? 'dueño' : p.role === 'writer' ? 'edita' : 'mira';
      const btn = slot(li, 'remove');
      if (p.role === 'owner') btn.hidden = true;
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
  $('share-off').hidden = Boolean(rec);
  $('share-on').hidden = !rec;
  if (!rec) return;
  $('share-link').value = inviteUrl(rec);
  const when = rec.lastSyncAt
    ? new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(rec.lastSyncAt))
    : 'nunca';
  $('share-status').textContent = `Última sincronización: ${when}.`;
  renderMembers(rec);
};

const openShareDialog = () => {
  renderShareDialog();
  els.dlgShare.showModal();
};

const shareNow = async () => {
  const v = store.activeVacation();
  if (!v) return;
  try {
    await ensureActor();
  } catch { return; }
  els.shareBtnStart.disabled = true;
  els.shareBtnStart.textContent = 'Conectando…';
  try {
    if (!drive.hasToken()) await drive.authorize({ prompt: 'consent' });
    await sync.shareTravel(v.id);
    renderShareDialog();
    updateChip();
  } catch (err) {
    showShareError(err);
  } finally {
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

const copyInvite = async () => {
  const url = $('share-link').value;
  try {
    if (navigator.share) { await navigator.share({ url }); return; }
  } catch { return; }
  try {
    await navigator.clipboard.writeText(url);
    els.shareCopyBtn.textContent = '¡Copiado!';
    setTimeout(() => { els.shareCopyBtn.textContent = 'Copiar'; }, 1600);
  } catch {
    $('share-link').focus();
    $('share-link').select();
  }
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

// ---------- unirse por invitación ----------

const stripJoinParam = () => {
  const url = new URL(location.href);
  url.searchParams.delete('join');
  history.replaceState(null, '', url);
};

const showJoinError = (message) => {
  $('join-error').textContent = message;
  $('join-error').hidden = false;
};

const joinGo = async () => {
  $('join-error').hidden = true;
  try {
    await ensureActor();
  } catch { return; }
  els.joinGoBtn.disabled = true;
  try {
    if (!drive.hasToken()) await drive.authorize({ prompt: 'consent' });
    const travel = joinMode === 'picker'
      ? await sync.joinViaPicker()
      : await sync.joinTravel(joinFileId);
    if (!travel) return; // canceló el selector
    els.dlgJoin.close();
    stripJoinParam();
    flash(`Te uniste a «${travel.meta.name}»`);
  } catch (err) {
    console.error('join failed', err);
    if (err.code === 'NO_ACCESS' && joinMode === 'direct') {
      // drive.file: la app no ve el archivo hasta que el usuario elige la
      // carpeta compartida en el selector de Google.
      joinMode = 'picker';
      $('join-picker').hidden = false;
      els.joinGoBtn.textContent = 'Elegir carpeta';
    } else if (err.code === 'OFFLINE') {
      showJoinError('Sin conexión. Abrí el enlace de nuevo cuando tengas internet.');
    } else if (err.code === 'NOT_A_TRAVEL' || err.code === 'INVALID_REMOTE') {
      showJoinError('Eso no parece un viaje de esta app.');
    } else {
      showJoinError('No se pudo abrir la invitación. Revisá que entraste con la cuenta invitada.');
    }
  } finally {
    els.joinGoBtn.disabled = false;
  }
};

const handleJoinParam = () => {
  const id = new URLSearchParams(location.search).get('join');
  if (!id) return;
  if (!sync.validInviteFileId(id)) { stripJoinParam(); return; }
  joinFileId = id;
  joinMode = 'direct';
  $('join-picker').hidden = true;
  $('join-error').hidden = true;
  els.joinGoBtn.textContent = 'Conectar y abrir';
  els.dlgJoin.showModal();
};

// ---------- arranque ----------

export const initShare = () => {
  els = {
    chip: $('sync-chip'),
    dlgShare: $('dlg-share'),
    dlgConflicts: $('dlg-conflicts'),
    dlgName: $('dlg-name'),
    dlgJoin: $('dlg-join'),
    shareError: $('share-error'),
    shareBtnStart: $('btn-share-start'),
    shareCopyBtn: $('btn-share-copy'),
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
  els.shareCopyBtn.onclick = () => copyInvite();
  els.memberForm.addEventListener('submit', addMember);
  els.dlgShare.onclick = (ev) => { if (ev.target === els.dlgShare) els.dlgShare.close(); };

  els.joinGoBtn.onclick = () => joinGo();
  $('btn-join-cancel').onclick = () => { els.dlgJoin.close(); stripJoinParam(); };

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
  handleJoinParam();
};
