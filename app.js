import { store, TRIP } from './store.js';
import { makeCommand } from './commands.js';
import { CITIES, findCity } from './cities.js';
import * as tripMap from './map.js';

const KINDS = {
  viaje: 'Viaje',
  museo: 'Museo',
  foto: 'Fotos',
  comida: 'Comida',
  teatro: 'Teatro',
  recital: 'Recital',
  otro: 'Otro',
};

const $ = (id) => document.getElementById(id);
const els = {
  cards: $('cards'),
  empty: $('empty-state'),
  count: $('count-stamp'),
  routeInfo: $('route-info'),
  routeText: document.querySelector('#route-info [data-slot="route-text"]'),
  banner: $('persist-banner'),
  undo: $('btn-undo'),
  redo: $('btn-redo'),
  fab: $('fab'),
  dlgForm: $('dlg-form'),
  form: $('form-activity'),
  formTitle: document.querySelector('[data-slot="form-title"]'),
  formSubmit: document.querySelector('[data-slot="form-submit"]'),
  formError: $('form-error'),
  formCancel: $('btn-form-cancel'),
  dlgConfirm: $('dlg-confirm'),
  confirmTitle: $('confirm-title'),
  confirmBody: $('confirm-body'),
  confirmAccept: document.querySelector('[data-confirm-accept]'),
  confirmCancel: document.querySelector('[data-confirm-cancel]'),
  fileImport: $('file-import'),
  fileAppend: $('file-append'),
  dlgTools: $('dlg-tools'),
  fabTools: $('fab-tools'),
  dlgGpt: $('dlg-gpt'),
  gptPrompt: $('gpt-prompt'),
  gptCopy: $('btn-gpt-copy'),
};

const cloneTpl = (id) => $(id).content.firstElementChild.cloneNode(true);
const slot = (node, name) => node.querySelector(`[data-slot="${name}"]`);

// ---------- fechas ----------

const parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const fmtDay = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric', month: 'short' });

const tripDayNum = (s) =>
  Math.round((parseDate(s) - parseDate(TRIP.start)) / 86400000) + 1;

const fmtRange = (act) => {
  if (!act.end || act.end === act.start) return `${fmtDay.format(parseDate(act.start))} · por el día`;
  return `${fmtDay.format(parseDate(act.start))} → ${fmtDay.format(parseDate(act.end))}`;
};

const fmtTripDays = (act) => {
  const a = tripDayNum(act.start);
  const b = act.end ? tripDayNum(act.end) : a;
  return a === b ? `Día ${a} del viaje` : `Días ${a}–${b} del viaje`;
};

// ---------- selección + ruta ----------

let selectedId = null;
const sorted = () =>
  [...store.state.doc.activities].sort(
    (x, y) => x.start.localeCompare(y.start) || (x.end || x.start).localeCompare(y.end || y.start)
  );

const routeText = (act) => {
  const km = tripMap.haversineKm(TRIP.base, act);
  const roadKm = Math.round(km * 1.25);
  const mins = Math.round((roadKm / 85) * 60);
  const time = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `${TRIP.base.name} → ${act.city} · ~${roadKm} km · ~${time} en auto`;
};

const showRouteFor = (act, { fit } = {}) => {
  tripMap.showRoute(TRIP.base, act, { fit });
  els.routeText.textContent = routeText(act);
  els.routeInfo.hidden = false;
};

const hideRoute = () => {
  tripMap.clearRoute();
  els.routeInfo.hidden = true;
};

const applyActiveClasses = () => {
  for (const li of els.cards.children) {
    li.classList.toggle('card--active', li.dataset.id === selectedId);
  }
};

const select = (act, { scrollCard = false } = {}) => {
  if (selectedId === act.id) {
    selectedId = null;
    hideRoute();
  } else {
    selectedId = act.id;
    showRouteFor(act, { fit: true });
    if (scrollCard) {
      const li = [...els.cards.children].find((n) => n.dataset.id === act.id);
      li?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  applyActiveClasses();
  tripMap.renderMarkers(sorted(), selectedId, (a) => select(a, { scrollCard: true }));
};

// ---------- confirm dialog ----------

let confirmResolver = null;
const settleConfirm = (value) => {
  if (confirmResolver) { confirmResolver(value); confirmResolver = null; }
  if (els.dlgConfirm.open) els.dlgConfirm.close();
};

const askConfirm = ({ title, body, acceptLabel = 'Borrar' }) =>
  new Promise((resolve) => {
    els.confirmTitle.textContent = title;
    els.confirmBody.textContent = body || '';
    els.confirmBody.hidden = !body;
    els.confirmAccept.textContent = acceptLabel;
    confirmResolver = resolve;
    els.dlgConfirm.showModal();
  });

els.confirmAccept.onclick = () => settleConfirm(true);
els.confirmCancel.onclick = () => settleConfirm(false);
els.dlgConfirm.addEventListener('close', () => { if (confirmResolver) settleConfirm(false); });
// onclick (propiedad) y no addEventListener: iOS solo dispara click en
// elementos no interactivos si tienen la propiedad onclick o cursor:pointer.
els.dlgConfirm.onclick = (ev) => { if (ev.target === els.dlgConfirm) settleConfirm(false); };

// ---------- formulario ----------

let editingId = null;

const showFormError = (msg) => {
  els.formError.textContent = msg;
  els.formError.hidden = false;
};

const openForm = (act) => {
  editingId = act?.id ?? null;
  els.formTitle.textContent = act ? 'Editar parada' : 'Nueva parada';
  els.formSubmit.textContent = act ? 'Guardar cambios' : 'Añadir al viaje';
  els.formError.hidden = true;
  const f = els.form;
  f.reset();
  f.elements.title.value = act?.title ?? '';
  f.elements.city.value = act?.city ?? '';
  f.elements.start.value = act?.start ?? '';
  f.elements.end.value = act?.end ?? '';
  f.elements.desc.value = act?.desc ?? '';
  f.elements.photos.value = (act?.photos ?? []).join('\n');
  f.elements.kind.value = act?.kind ?? 'viaje';
  els.dlgForm.showModal();
};

els.formCancel.onclick = () => els.dlgForm.close();
els.dlgForm.onclick = (ev) => { if (ev.target === els.dlgForm) els.dlgForm.close(); };

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = els.form;
  const title = f.elements.title.value.trim();
  const cityName = f.elements.city.value.trim();
  const start = f.elements.start.value;
  let end = f.elements.end.value || '';
  const desc = f.elements.desc.value.trim();
  const kind = f.elements.kind.value;
  const photos = f.elements.photos.value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));

  if (!title) return showFormError('Falta el título.');
  let city = findCity(cityName);
  if (!city && editingId) {
    // Paradas importadas pueden traer ciudades fuera del gazetteer; si el
    // nombre no cambió, conservamos sus coordenadas originales.
    const orig = store.state.doc.activities.find((a) => a.id === editingId);
    if (orig && orig.city === cityName) city = { name: orig.city, lat: orig.lat, lon: orig.lon };
  }
  if (!city) return showFormError(`No conozco «${cityName}». Elegí una ciudad de la lista.`);
  if (!start) return showFormError('Falta la fecha de inicio.');
  if (start < TRIP.start || start > TRIP.end) {
    return showFormError('Esa fecha cae fuera del viaje (31 oct 2026 – 4 ene 2027).');
  }
  if (end && end < start) end = start;
  if (end && end > TRIP.end) end = TRIP.end;

  const activity = {
    id: editingId ?? crypto.randomUUID(),
    kind,
    title,
    city: city.name,
    lat: city.lat,
    lon: city.lon,
    start,
    end: end && end !== start ? end : '',
    desc,
    photos,
  };

  els.dlgForm.close();
  const targetId = editingId;
  // Diferido un tick: iOS todavía está desmontando el picker nativo de fecha
  // cuando dispara submit; reconstruir el DOM en el mismo frame lo hace parpadear.
  setTimeout(() => {
    if (targetId) {
      const from = store.state.doc.activities.find((a) => a.id === targetId);
      if (!from) return;
      store.dispatch(makeCommand('UPDATE_ACTIVITY', { id: targetId, from, to: activity }));
    } else {
      store.dispatch(makeCommand('ADD_ACTIVITY', { activity }));
    }
  }, 0);
});

// ---------- render ----------

const animated = new Set();

const rangesOverlap = (a, b) =>
  a.start <= (b.end || b.start) && b.start <= (a.end || a.start);

const renderCards = () => {
  const acts = sorted();
  els.count.textContent = acts.length === 1 ? '1 parada' : `${acts.length} paradas`;
  els.empty.hidden = acts.length > 0;

  const nodes = acts.map((act, i) => {
    const li = cloneTpl('tpl-card');
    li.dataset.id = act.id;
    if (!animated.has(act.id)) {
      animated.add(act.id);
      li.classList.add('is-animate');
      li.style.setProperty('--i', String(Math.min(i, 6)));
    }
    slot(li, 'num').textContent = String(i + 1);
    const stamp = slot(li, 'stamp');
    stamp.textContent = KINDS[act.kind] ?? KINDS.otro;
    stamp.style.setProperty('--k', `var(--k-${KINDS[act.kind] ? act.kind : 'otro'})`);
    slot(li, 'title').textContent = act.title;
    slot(li, 'city').textContent = act.city;
    slot(li, 'dates').textContent = fmtRange(act);
    slot(li, 'days').textContent = fmtTripDays(act);
    slot(li, 'desc').textContent = act.desc;

    const clashes = acts.filter((o) => o.id !== act.id && rangesOverlap(act, o));
    if (clashes.length) {
      li.classList.add('card--clash');
      const warn = slot(li, 'warn');
      warn.hidden = false;
      slot(li, 'warn-text').textContent =
        `Choca con ${clashes.map((o) => `${o.title} (${o.city})`).join(', ')}`;
    }

    const photosBox = slot(li, 'photos');
    if (act.photos.length) {
      photosBox.hidden = false;
      for (const url of act.photos) {
        const a = cloneTpl('tpl-photo');
        a.href = url;
        const img = a.querySelector('img');
        img.src = url;
        img.onerror = () => { a.hidden = true; };
        photosBox.appendChild(a);
      }
    }

    const body = slot(li, 'body');
    body.onclick = () => select(act);
    body.addEventListener('mouseenter', () => {
      if (!selectedId) showRouteFor(act, { fit: false });
    });
    body.addEventListener('mouseleave', () => {
      if (!selectedId) hideRoute();
    });

    slot(li, 'edit').onclick = () => openForm(act);
    slot(li, 'delete').onclick = async () => {
      const ok = await askConfirm({
        title: `¿Borrar «${act.title}»?`,
        body: 'Podés deshacerlo con ↶.',
      });
      if (!ok) return;
      const index = store.state.doc.activities.findIndex((a) => a.id === act.id);
      store.dispatch(makeCommand('REMOVE_ACTIVITY', { activity: act, index }));
    };

    return li;
  });

  els.cards.replaceChildren(...nodes);
};

const render = () => {
  const acts = sorted();
  if (selectedId && !acts.some((a) => a.id === selectedId)) {
    selectedId = null;
    hideRoute();
  }
  renderCards();
  applyActiveClasses();
  tripMap.renderMarkers(acts, selectedId, (a) => select(a, { scrollCard: true }));
  const sel = acts.find((a) => a.id === selectedId);
  if (sel) showRouteFor(sel, { fit: false });
  els.undo.disabled = !store.canUndo();
  els.redo.disabled = !store.canRedo();
  els.banner.hidden = !store.persistError;
};

// ---------- exportar / importar ----------

const exportJson = async () => {
  const data = {
    app: 'travel-42uy',
    version: 1,
    trip: TRIP,
    exportedAt: new Date().toISOString(),
    activities: store.state.doc.activities,
  };
  const text = JSON.stringify(data, null, 2);
  const filename = 'travel-espana-2027.json';
  const blob = new Blob([text], { type: 'application/json' });
  try {
    const file = new File([blob], filename, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch {}
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const validActivity = (a) =>
  a && typeof a === 'object' &&
  typeof a.title === 'string' && typeof a.city === 'string' &&
  typeof a.lat === 'number' && typeof a.lon === 'number' &&
  isIsoDate(a.start) && a.start >= TRIP.start && a.start <= TRIP.end &&
  (a.end == null || a.end === '' || isIsoDate(a.end));

const sanitizeActivity = (a) => ({
  id: crypto.randomUUID(),
  kind: KINDS[a.kind] ? a.kind : 'otro',
  title: a.title,
  city: a.city,
  lat: a.lat,
  lon: a.lon,
  start: a.start,
  end: isIsoDate(a.end) && a.end !== a.start ? (a.end > TRIP.end ? TRIP.end : a.end) : '',
  desc: typeof a.desc === 'string' ? a.desc : '',
  photos: Array.isArray(a.photos) ? a.photos.filter((p) => typeof p === 'string' && /^https?:\/\//i.test(p)) : [],
});

const parseActivitiesFile = async (file) => {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    await askConfirm({ title: 'Archivo inválido', body: 'Ese archivo no es un JSON válido.', acceptLabel: 'OK' });
    return null;
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.activities) ? data.activities : null;
  if (!list || !list.length || !list.every(validActivity)) {
    await askConfirm({
      title: 'Archivo inválido',
      body: 'No encontré paradas válidas (título, ciudad, lat/lon y fechas dentro del viaje).',
      acceptLabel: 'OK',
    });
    return null;
  }
  return list;
};

const importJson = async (file) => {
  const list = await parseActivitiesFile(file);
  if (!list) return;
  const ok = await askConfirm({
    title: '¿Importar itinerario?',
    body: `Reemplaza las paradas actuales por las ${list.length} del archivo. No se puede deshacer.`,
    acceptLabel: 'Importar',
  });
  if (!ok) return;
  animated.clear();
  store.replaceAll(list.map(sanitizeActivity));
};

const importAppend = async (file) => {
  const list = await parseActivitiesFile(file);
  if (!list) return;
  const ok = await askConfirm({
    title: '¿Añadir al itinerario?',
    body: `Agrega ${list.length === 1 ? '1 parada' : `${list.length} paradas`} a las que ya tenés. Podés deshacerlo.`,
    acceptLabel: 'Añadir',
  });
  if (!ok) return;
  store.dispatch(makeCommand('ADD_ACTIVITIES', { activities: list.map(sanitizeActivity) }));
};

// ---------- ChatGPT ----------

const buildGptPrompt = () => {
  const acts = sorted();
  const occupied = acts.length
    ? acts.map((a) => `${a.start}${a.end ? `→${a.end}` : ''} (${a.city})`).join(', ')
    : '(ninguna por ahora)';
  return [
    'Sos mi asistente para organizar un viaje a España. Contexto:',
    '- Estadía: del 2026-10-31 al 2027-01-04 (fechas fijas).',
    '- Base: Paterna, Valencia — vuelvo a dormir ahí salvo escapadas con noche.',
    '- Me encanta la fotografía: proponé spots de fotos (miradores, atardeceres, cascos antiguos).',
    '',
    'Ayudame a planificar paradas: escapadas de varios días, visitas por el día, museos, comida y lugares para fotografiar. Charlemos lo que haga falta; cuando yo escriba «exportar», respondé ÚNICAMENTE con un JSON válido (sin markdown, sin texto extra) con exactamente esta forma:',
    '',
    '{"app":"travel-42uy","version":1,"activities":[{"title":"Escapada a Benidorm","kind":"viaje","city":"Benidorm","lat":38.5342,"lon":-0.1314,"start":"2026-12-10","end":"2026-12-13","desc":"Playa de Levante y casco antiguo.","photos":[]}]}',
    '',
    'Reglas del JSON:',
    '- "kind" es uno de: "viaje", "museo", "foto", "comida", "teatro", "recital", "otro".',
    '- "start"/"end" en formato YYYY-MM-DD, dentro del viaje. Si es por el día, "end":"".',
    '- "lat"/"lon" numéricos reales del centro de la ciudad, con 4 decimales.',
    '- "photos" siempre [].',
    '- "desc" corta, en español.',
    `- Estas fechas ya están ocupadas, no las pises: ${occupied}`,
  ].join('\n');
};

const openGptDialog = () => {
  els.gptPrompt.value = buildGptPrompt();
  els.gptCopy.textContent = 'Copiar prompt';
  els.dlgGpt.showModal();
};

const copyGptPrompt = async () => {
  const text = els.gptPrompt.value;
  try {
    await navigator.clipboard.writeText(text);
    els.gptCopy.textContent = '¡Copiado!';
    setTimeout(() => { els.gptCopy.textContent = 'Copiar prompt'; }, 1600);
  } catch {
    els.gptPrompt.focus();
    els.gptPrompt.select();
  }
};

// ---------- arranque ----------

const isEditableTarget = (t) =>
  t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

const onKeyDown = (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta || isEditableTarget(e.target)) return;
  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    if (e.shiftKey) store.redo(); else store.undo();
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    store.redo();
  }
};

let reloadingForUpdate = false;
const doReload = () => {
  if (reloadingForUpdate) return;
  reloadingForUpdate = true;
  location.reload();
};

const wireSwReload = () => {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'RELOAD') return;
    if (isEditableTarget(document.activeElement) || els.dlgForm.open) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') doReload();
      });
    } else {
      doReload();
    }
  });
};

const start = async () => {
  await store.ready;

  const datalist = $('city-list');
  for (const c of CITIES) {
    const opt = document.createElement('option');
    opt.value = c.name;
    datalist.appendChild(opt);
  }

  tripMap.initMap($('map'), TRIP.base);

  els.fab.onclick = () => openForm(null);
  els.undo.onclick = () => store.undo();
  els.redo.onclick = () => store.redo();

  els.fabTools.onclick = () => els.dlgTools.showModal();
  els.dlgTools.onclick = (ev) => { if (ev.target === els.dlgTools) els.dlgTools.close(); };
  $('btn-export').onclick = () => { els.dlgTools.close(); exportJson(); };
  $('btn-banner-export').onclick = () => exportJson();
  $('btn-import').onclick = () => { els.dlgTools.close(); els.fileImport.click(); };
  $('btn-gpt').onclick = () => { els.dlgTools.close(); openGptDialog(); };

  $('btn-gpt-cancel').onclick = () => els.dlgGpt.close();
  els.dlgGpt.onclick = (ev) => { if (ev.target === els.dlgGpt) els.dlgGpt.close(); };
  els.gptCopy.onclick = () => copyGptPrompt();
  $('btn-gpt-import').onclick = () => { els.dlgGpt.close(); els.fileAppend.click(); };

  els.fileImport.onchange = () => {
    const file = els.fileImport.files?.[0];
    els.fileImport.value = '';
    if (file) importJson(file);
  };
  els.fileAppend.onchange = () => {
    const file = els.fileAppend.files?.[0];
    els.fileAppend.value = '';
    if (file) importAppend(file);
  };

  window.addEventListener('keydown', onKeyDown);
  wireSwReload();

  store.subscribe(render);
  render();
  requestAnimationFrame(() => tripMap.invalidateSize());
};

start();
