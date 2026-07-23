import { store } from './store.js';
import { makeCommand, alive } from './commands.js';
import { CITIES, findCity } from './cities.js';
import * as tripMap from './map.js';
import { askConfirm } from './confirm.js';
import { initShare, attachFile, openAttachment, removeAttachment } from './share.js';

const KINDS = {
  viaje: 'Viaje',
  museo: 'Museo',
  foto: 'Fotos',
  comida: 'Comida',
  teatro: 'Teatro',
  recital: 'Recital',
  otro: 'Otro',
};

// Solo estas clases son rangos (Desde/Hasta); el resto es fecha + hora opcional.
const RANGE_KINDS = new Set(['viaje', 'otro']);
const isRangeKind = (kind) => RANGE_KINDS.has(kind);

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
  fileImport: $('file-import'),
  fileAppend: $('file-append'),
  fileAttach: $('file-attach'),
  dlgTools: $('dlg-tools'),
  fabTools: $('fab-tools'),
  dlgGpt: $('dlg-gpt'),
  gptPrompt: $('gpt-prompt'),
  gptCopy: $('btn-gpt-copy'),
  welcome: $('welcome'),
  mapCard: $('map-card'),
  timeline: $('timeline'),
  tripName: document.querySelector('[data-slot="trip-name"]'),
  tripSub: document.querySelector('[data-slot="trip-sub"]'),
  btnVacations: $('btn-vacations'),
  dlgVacForm: $('dlg-vacation'),
  vacForm: $('form-vacation'),
  vacError: $('vac-error'),
};

const cloneTpl = (id) => $(id).content.firstElementChild.cloneNode(true);
const slot = (node, name) => node.querySelector(`[data-slot="${name}"]`);

const trip = () => store.activeVacation();

// ---------- fechas ----------

const parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const fmtDay = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShort = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: '2-digit' });

const tripDayNum = (s) =>
  Math.round((parseDate(s) - parseDate(trip().meta.start)) / 86400000) + 1;

const fmtRange = (act) => {
  if (!act.end || act.end === act.start) {
    const day = fmtDay.format(parseDate(act.start));
    return act.time ? `${day} · ${act.time}` : `${day} · por el día`;
  }
  return `${fmtDay.format(parseDate(act.start))} → ${fmtDay.format(parseDate(act.end))}`;
};

const fmtTripDays = (act) => {
  const a = tripDayNum(act.start);
  const b = act.end ? tripDayNum(act.end) : a;
  return a === b ? `Día ${a} del viaje` : `Días ${a}–${b} del viaje`;
};

const fmtTripRange = (v) =>
  `${fmtShort.format(parseDate(v.meta.start))} → ${fmtShort.format(parseDate(v.meta.end))}`;

// ---------- selección + ruta ----------

let selectedId = null;
const sorted = () => {
  const v = trip();
  if (!v) return [];
  return alive(v.activities).sort(
    (x, y) => x.start.localeCompare(y.start) ||
      (x.time || '').localeCompare(y.time || '') ||
      (x.end || x.start).localeCompare(y.end || y.start)
  );
};

const routeText = (act) => {
  const base = trip().meta.base;
  const km = tripMap.haversineKm(base, act);
  const roadKm = Math.round(km * 1.25);
  const mins = Math.round((roadKm / 85) * 60);
  const time = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `${base.name} → ${act.city} · ~${roadKm} km · ~${time} en auto`;
};

const showRouteFor = (act, { fit } = {}) => {
  tripMap.showRoute(trip().meta.base, act, { fit });
  els.routeText.textContent = routeText(act);
  els.routeInfo.hidden = false;
};

const hideRoute = () => {
  tripMap.clearRoute();
  els.routeInfo.hidden = true;
};

const applyActiveClasses = () => {
  for (const li of els.cards.children) {
    const open = li.dataset.id === selectedId;
    li.classList.toggle('card--open', open);
    li.querySelector('.card__head')?.setAttribute('aria-expanded', String(open));
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

// ---------- vacaciones ----------

const resetView = () => {
  selectedId = null;
  selectedDay = null;
  animated.clear();
  hideRoute();
};

// ---------- splash: pared de afiches (dashboard de viajes) ----------
// Primera pantalla y hub único: acá se elige, crea, borra y se une a viajes.
// Mosaico por fecha de creación (desc). El array doc.vacations se llena por
// append (crear y unirse), así que el orden de creación es el del array —
// no hace falta un createdAt.

const SPLASH_PALETTE = [
  ['#C73E1D', '#F3D9CE'],
  ['#20668C', '#D6E4EC'],
  ['#7B4B94', '#E4D9EC'],
  ['#4E7C4E', '#DCE7D8'],
  ['#B07D2B', '#F0E3C8'],
  ['#AD3B6E', '#EFD8E2'],
];
const SPLASH_MOTIFS = ['#m-sun', '#m-waves', '#m-peak', '#m-compass'];

// Con quién está compartido: nombres vistos en el registro y en los stamps
// de entidades (updatedBy), menos el propio. Sin red: es lo que ya sabemos.
const sharedWithNames = (v) => {
  const names = new Set();
  for (const e of v.log ?? []) if (e.by) names.add(e.by);
  for (const a of v.activities) if (a.updatedBy) names.add(a.updatedBy);
  for (const a of v.attachments) if (a.updatedBy) names.add(a.updatedBy);
  if (v.meta.updatedBy) names.add(v.meta.updatedBy);
  names.delete(store.actor);
  return [...names];
};

let splashTimer = null;
let splashShownFor = null; // activeId al abrir: si cambia, el splash se cierra

const hideSplash = () => {
  const s = $('splash');
  if (s.hidden) return;
  s.classList.add('splash--closing');
  clearTimeout(splashTimer);
  splashTimer = setTimeout(() => { s.hidden = true; s.classList.remove('splash--closing'); }, 320);
};

const showSplash = () => {
  const { vacations } = store.state.doc;
  if (!vacations.length) return;
  splashShownFor = store.state.doc.activeId;
  clearTimeout(splashTimer);
  $('splash').classList.remove('splash--closing');
  const list = [...vacations].reverse();
  $('splash-grid').replaceChildren(...list.map((v, i) => {
    const li = cloneTpl('tpl-splash-tile');
    if (i === 0) li.classList.add('splash-tile--featured');
    const [accent, soft] = SPLASH_PALETTE[i % SPLASH_PALETTE.length];
    li.style.setProperty('--accent', accent);
    li.style.setProperty('--accent-soft', soft);
    li.style.setProperty('--i', String(Math.min(i, 8)));
    li.classList.add('is-animate');
    slot(li, 'motif').setAttribute('href', SPLASH_MOTIFS[i % SPLASH_MOTIFS.length]);
    slot(li, 'dest').textContent = v.meta.base.name;
    slot(li, 'name').textContent = v.meta.name;
    slot(li, 'dates').textContent = fmtTripRange(v);
    if (store.isShared(v.id)) {
      slot(li, 'shared').hidden = false;
      const names = sharedWithNames(v);
      slot(li, 'shared-text').textContent = names.length
        ? `Con ${names.slice(0, 2).join(' y ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`
        : 'Compartido';
    }
    slot(li, 'open').onclick = () => {
      if (v.id !== store.state.doc.activeId) {
        resetView();
        store.switchVacation(v.id);
      }
      hideSplash();
    };
    slot(li, 'del').onclick = async () => {
      const ok = await askConfirm({
        title: `¿Borrar «${v.meta.name}»?`,
        body: 'Se pierden todas sus paradas. No se puede deshacer.',
      });
      if (!ok) return;
      resetView();
      store.deleteVacation(v.id);
      if (store.state.doc.vacations.length) showSplash();
    };
    return li;
  }));
  $('splash').hidden = false;
};

// ---------- historial de cambios ----------

const fmtLogTs = new Intl.DateTimeFormat('es', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

const LOG_FIELD_NAMES = {
  title: 'título', kind: 'tipo', city: 'ciudad', lat: 'ubicación', lon: 'ubicación',
  start: 'fechas', end: 'fechas', time: 'hora', desc: 'descripción',
  name: 'nombre', base: 'ciudad base',
};

const logLabel = (e) => {
  const n = e.count ?? 0;
  switch (e.action) {
    case 'add': return `Añadió «${e.title}»`;
    case 'add-many': return n === 1 ? 'Añadió 1 parada' : `Añadió ${n} paradas`;
    case 'update': return `Editó «${e.title}»`;
    case 'remove': return `Borró «${e.title}»`;
    case 'remove-many': return n === 1 ? 'Borró 1 parada' : `Borró ${n} paradas`;
    case 'import': return `Importó un itinerario (${n === 1 ? '1 parada' : `${n} paradas`})`;
    case 'attach': return `Adjuntó «${e.title}»`;
    case 'detach': return `Quitó el adjunto «${e.title}»`;
    case 'meta': return 'Editó los datos del viaje';
    default: return e.action;
  }
};

const logDetail = (e, shared) => {
  const parts = [];
  if (shared) parts.push(e.by || 'Alguien');
  parts.push(fmtLogTs.format(new Date(e.ts)));
  const fields = [...new Set((e.fields ?? []).map((f) => LOG_FIELD_NAMES[f] ?? f))];
  if (fields.length) parts.push(`cambió: ${fields.join(', ')}`);
  return parts.join(' · ');
};

const openLogDrawer = () => {
  const v = trip();
  if (!v) return;
  const shared = store.isShared(v.id);
  const entries = [...(v.log ?? [])].sort((a, b) => b.ts.localeCompare(a.ts));
  $('log-empty').hidden = entries.length > 0;
  $('log-list').replaceChildren(...entries.map((e) => {
    const li = el('li', 'log-item');
    li.append(
      el('span', 'log-item__what', logLabel(e)),
      el('span', 'log-item__sub', logDetail(e, shared)),
    );
    return li;
  }));
  $('dlg-log').showModal();
};

const showVacError = (msg) => {
  els.vacError.textContent = msg;
  els.vacError.hidden = false;
};

const openVacForm = () => {
  els.vacError.hidden = true;
  els.vacForm.reset();
  els.dlgVacForm.showModal();
};

els.vacForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = els.vacForm;
  const name = f.elements.name.value.trim();
  const start = f.elements.start.value;
  const end = f.elements.end.value;
  const baseName = f.elements.base.value.trim();

  if (!name) return showVacError('Falta el nombre del viaje.');
  if (!start) return showVacError('Falta la fecha de inicio.');
  if (!end) return showVacError('Falta la fecha de fin.');
  if (end < start) return showVacError('El viaje no puede terminar antes de empezar.');
  const city = findCity(baseName);
  if (!city) return showVacError(`No conozco «${baseName}». Elegí una ciudad de la lista.`);

  const now = new Date().toISOString();
  const vacation = {
    id: crypto.randomUUID(),
    revision: 0,
    meta: {
      name,
      start,
      end,
      base: { name: city.name, lat: city.lat, lon: city.lon },
      rev: 0,
      updatedAt: now,
      updatedBy: store.actor ?? null,
    },
    activities: [],
    attachments: [],
  };

  els.dlgVacForm.close();
  // Diferido un tick: iOS todavía está desmontando el picker nativo de fecha
  // cuando dispara submit; reconstruir el DOM en el mismo frame lo hace parpadear.
  setTimeout(() => {
    resetView();
    store.createVacation(vacation);
  }, 0);
});

// ---------- formulario de paradas ----------

let editingId = null;

const showFormError = (msg) => {
  els.formError.textContent = msg;
  els.formError.hidden = false;
};

// Alterna Desde/Hasta vs Fecha/Hora según el tipo elegido.
const syncFormKind = () => {
  const range = isRangeKind(els.form.elements.kind.value);
  $('lbl-start').textContent = range ? 'Desde' : 'Fecha';
  $('field-end').hidden = !range;
  $('field-time').hidden = range;
  $('hint-dates').textContent = range
    ? 'Dejá «Hasta» vacío si es por el día.'
    : 'La hora es opcional.';
};

els.form.addEventListener('change', (e) => {
  if (e.target.name === 'kind') syncFormKind();
});

const openForm = (act) => {
  const v = trip();
  editingId = act?.id ?? null;
  els.formTitle.textContent = act ? 'Editar actividad' : 'Nueva actividad';
  els.formSubmit.textContent = act ? 'Guardar cambios' : 'Añadir al viaje';
  els.formError.hidden = true;
  const f = els.form;
  f.reset();
  f.elements.start.min = v.meta.start;
  f.elements.start.max = v.meta.end;
  f.elements.end.min = v.meta.start;
  f.elements.end.max = v.meta.end;
  f.elements.title.value = act?.title ?? '';
  f.elements.city.value = act?.city ?? '';
  f.elements.start.value = act?.start ?? '';
  f.elements.end.value = act?.end ?? '';
  f.elements.time.value = act?.time ?? '';
  f.elements.desc.value = act?.desc ?? '';
  f.elements.kind.value = act?.kind ?? 'viaje';
  syncFormKind();
  els.dlgForm.showModal();
};

els.formCancel.onclick = () => els.dlgForm.close();

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = trip();
  const f = els.form;
  const title = f.elements.title.value.trim();
  const cityName = f.elements.city.value.trim();
  const start = f.elements.start.value;
  const desc = f.elements.desc.value.trim();
  const kind = f.elements.kind.value;
  let end = isRangeKind(kind) ? f.elements.end.value || '' : '';
  const time = isRangeKind(kind) ? '' : f.elements.time.value || '';
  // El formulario ya no edita fotos: se conservan las existentes (importadas).
  const photos = editingId
    ? v.activities.find((a) => a.id === editingId)?.photos ?? []
    : [];

  if (!title) return showFormError('Falta el título.');
  let city = findCity(cityName);
  if (!city && editingId) {
    // Paradas importadas pueden traer ciudades fuera del gazetteer; si el
    // nombre no cambió, conservamos sus coordenadas originales.
    const orig = v.activities.find((a) => a.id === editingId);
    if (orig && orig.city === cityName) city = { name: orig.city, lat: orig.lat, lon: orig.lon };
  }
  if (!city) return showFormError(`No conozco «${cityName}». Elegí una ciudad de la lista.`);
  if (!start) return showFormError('Falta la fecha de inicio.');
  if (start < v.meta.start || start > v.meta.end) {
    return showFormError(`Esa fecha cae fuera del viaje (${fmtTripRange(v)}).`);
  }
  if (end && end < start) end = start;
  if (end && end > v.meta.end) end = v.meta.end;

  const activity = {
    id: editingId ?? crypto.randomUUID(),
    kind,
    title,
    city: city.name,
    lat: city.lat,
    lon: city.lon,
    start,
    end: end && end !== start ? end : '',
    time,
    desc,
    photos,
  };

  els.dlgForm.close();
  const targetId = editingId;
  // Diferido un tick: iOS todavía está desmontando el picker nativo de fecha
  // cuando dispara submit; reconstruir el DOM en el mismo frame lo hace parpadear.
  setTimeout(() => {
    if (targetId) {
      const from = trip()?.activities.find((a) => a.id === targetId);
      if (!from) return;
      store.dispatch(makeCommand('UPDATE_ACTIVITY', { id: targetId, from, to: activity }));
    } else {
      store.dispatch(makeCommand('ADD_ACTIVITY', { activity }));
    }
  }, 0);
});

// ---------- render ----------

const animated = new Set();
let attachTargetId = null;

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
    li.style.setProperty('--k', `var(--k-${KINDS[act.kind] ? act.kind : 'otro'})`);
    slot(li, 'num').textContent = String(i + 1);
    const d0 = parseDate(act.start);
    slot(li, 'date').textContent =
      `${String(d0.getDate()).padStart(2, '0')}/${String(d0.getMonth() + 1).padStart(2, '0')}`;
    slot(li, 'stamp').textContent = KINDS[act.kind] ?? KINDS.otro;
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
        const ph = cloneTpl('tpl-photo');
        const img = ph.querySelector('img');
        img.src = url;
        img.onerror = () => { ph.hidden = true; };
        ph.onclick = () => {
          $('lightbox-img').src = url;
          // Fotos remotas (URL): sin blob local, el lightbox no comparte.
          $('btn-photo-share').hidden = true;
          $('dlg-photo').showModal();
        };
        photosBox.appendChild(ph);
      }
    }

    // Adjuntos (entradas, PDFs): solo en viajes compartidos (los archivos
    // viven en la carpeta sincronizada). Los ya existentes se ven siempre.
    const shared = store.isShared(trip().id);
    const attBox = slot(li, 'attachments');
    const atts = alive(trip().attachments).filter((x) => x.activityId === act.id);
    if (atts.length) {
      attBox.hidden = false;
      for (const att of atts) {
        const chip = cloneTpl('tpl-attachment');
        slot(chip, 'att-name').textContent = att.name;
        if (!att.driveFileId) chip.classList.add('attachment--pending');
        slot(chip, 'att-open').onclick = () => openAttachment(att);
        slot(chip, 'att-delete').onclick = () => removeAttachment(att);
        attBox.appendChild(chip);
      }
    }
    const attachBtn = slot(li, 'attach');
    attachBtn.hidden = !shared;
    attachBtn.onclick = () => {
      attachTargetId = act.id;
      els.fileAttach.click();
    };

    const head = slot(li, 'head');
    head.onclick = () => select(act);
    head.addEventListener('mouseenter', () => {
      if (!selectedId) showRouteFor(act, { fit: false });
    });
    head.addEventListener('mouseleave', () => {
      if (!selectedId) hideRoute();
    });

    slot(li, 'edit').onclick = () => openForm(act);
    slot(li, 'delete').onclick = async () => {
      const ok = await askConfirm({
        title: `¿Borrar «${act.title}»?`,
        body: 'Podés deshacerlo con ↶.',
      });
      if (!ok) return;
      store.dispatch(makeCommand('REMOVE_ACTIVITY', { activity: act }));
    };

    return li;
  });

  els.cards.replaceChildren(...nodes);
};

// ---------- calendario ----------

let viewMode = 'list';
let selectedDay = null;

const toIso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const buildDayMap = (acts) => {
  const map = new Map();
  for (const act of acts) {
    const end = parseDate(act.end || act.start);
    for (let d = parseDate(act.start); d <= end; d.setDate(d.getDate() + 1)) {
      const iso = toIso(d);
      if (!map.has(iso)) map.set(iso, []);
      map.get(iso).push(act);
    }
  }
  return map;
};

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};

const monthFmt = new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric' });

const openDayDrawer = (dayActs) => {
  $('day-title').textContent =
    `${fmtDay.format(parseDate(selectedDay))} · Día ${tripDayNum(selectedDay)} del viaje`;
  $('day-list').replaceChildren(...dayActs.map((act) => {
    const li = el('li');
    const btn = el('button', 'day-detail__item');
    const top = el('span', 'day-detail__top');
    const dot = el('span', 'day-detail__dot');
    dot.style.setProperty('--k', `var(--k-${KINDS[act.kind] ? act.kind : 'otro'})`);
    top.append(dot, el('span', 'day-detail__name', act.title), el('span', 'day-detail__city', act.city));
    btn.appendChild(top);
    const subParts = [fmtRange(act)];
    if (act.desc) subParts.push(act.desc.length > 70 ? `${act.desc.slice(0, 70)}…` : act.desc);
    btn.appendChild(el('span', 'day-detail__sub', subParts.join(' · ')));
    btn.onclick = () => {
      $('dlg-day').close();
      if (selectedId !== act.id) select(act);
    };
    li.appendChild(btn);
    return li;
  }));
  $('dlg-day').showModal();
};

const renderCalendar = () => {
  const v = trip();
  const acts = sorted();
  const dayMap = buildDayMap(acts);
  const box = $('cal-months');
  const todayIso = toIso(new Date());
  const first = parseDate(v.meta.start);
  const last = parseDate(v.meta.end);

  const months = [];
  for (let m = new Date(first.getFullYear(), first.getMonth(), 1); m <= last; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    // Meses con un solo día de viaje (p. ej. solo la llegada) no se muestran,
    // salvo que el viaje entero quepa en un único mes.
    const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    let tripDays = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = toIso(new Date(m.getFullYear(), m.getMonth(), day));
      if (iso >= v.meta.start && iso <= v.meta.end) tripDays++;
    }
    if (tripDays > 1) months.push(m);
  }
  if (!months.length) months.push(new Date(first.getFullYear(), first.getMonth(), 1));

  box.replaceChildren(...months.map((m0) => {
    const card = el('div', 'cal-month');
    const name = monthFmt.format(m0);
    card.appendChild(el('h3', 'cal-month__name', name.charAt(0).toUpperCase() + name.slice(1)));
    const grid = el('div', 'cal-grid');
    for (const wd of ['L', 'M', 'X', 'J', 'V', 'S', 'D']) grid.appendChild(el('span', 'cal-wd', wd));
    const lead = (m0.getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) grid.appendChild(el('span', 'cal-blank'));
    const daysInMonth = new Date(m0.getFullYear(), m0.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = toIso(new Date(m0.getFullYear(), m0.getMonth(), day));
      const inTrip = iso >= v.meta.start && iso <= v.meta.end;
      const dayActs = dayMap.get(iso) ?? [];
      const cell = el('button', 'cal-day');
      cell.type = 'button';
      if (!inTrip) { cell.classList.add('cal-day--out'); cell.disabled = true; }
      if (iso === todayIso) cell.classList.add('cal-day--today');
      if (iso === selectedDay) cell.classList.add('cal-day--sel');
      cell.appendChild(el('span', 'cal-day__num', String(day)));
      if (dayActs.length) {
        const dots = el('span', 'cal-day__dots');
        for (const kind of [...new Set(dayActs.map((a) => a.kind))].slice(0, 4)) {
          const dot = el('span', 'cal-day__dot');
          dot.style.setProperty('--k', `var(--k-${KINDS[kind] ? kind : 'otro'})`);
          dots.appendChild(dot);
        }
        cell.appendChild(dots);
      } else if (inTrip) {
        cell.disabled = true;
        cell.classList.add('cal-day--free');
      }
      cell.onclick = () => {
        selectedDay = selectedDay === iso ? null : iso;
        renderCalendar();
        if (selectedDay && dayActs.length) {
          tripMap.focusOn(dayActs);
          openDayDrawer(dayActs);
        }
      };
      grid.appendChild(cell);
    }
    card.appendChild(grid);
    return card;
  }));
};

const setView = (mode) => {
  viewMode = mode;
  $('btn-view-list').classList.toggle('seg__btn--active', mode === 'list');
  $('btn-view-cal').classList.toggle('seg__btn--active', mode === 'cal');
  render();
};

let wasInApp = false;

const render = () => {
  const v = trip();
  const inApp = Boolean(v);

  // El splash se cierra solo cuando otro viaje pasa a ser el activo (elegir
  // en el mosaico, unirse por invitación). Borrar re-abre con showSplash().
  if (!$('splash').hidden && store.state.doc.activeId !== splashShownFor) hideSplash();

  els.welcome.hidden = inApp;
  els.mapCard.hidden = !inApp;
  els.timeline.hidden = !inApp;
  els.fab.hidden = !inApp;
  els.fabTools.hidden = !inApp;
  els.tripName.textContent = v ? v.meta.name : 'Travel';
  els.tripSub.textContent = v
    ? `${fmtTripRange(v)} · base ${v.meta.base.name}`
    : 'Planificá tus vacaciones';
  els.banner.hidden = !store.persistError;

  if (!inApp) {
    wasInApp = false;
    els.undo.disabled = true;
    els.redo.disabled = true;
    return;
  }

  tripMap.setBase(v.meta.base);
  if (!wasInApp) {
    wasInApp = true;
    // El mapa pudo inicializarse oculto (modo bienvenida): recalcular tamaño.
    requestAnimationFrame(() => tripMap.invalidateSize());
  }

  const acts = sorted();
  if (selectedId && !acts.some((a) => a.id === selectedId)) {
    selectedId = null;
    hideRoute();
  }
  renderCards();
  els.cards.hidden = viewMode !== 'list';
  els.empty.hidden = viewMode !== 'list' || acts.length > 0;
  $('calendar').hidden = viewMode !== 'cal';
  if (viewMode === 'cal') renderCalendar();
  applyActiveClasses();
  tripMap.renderMarkers(acts, selectedId, (a) => select(a, { scrollCard: true }));
  const sel = acts.find((a) => a.id === selectedId);
  if (sel) showRouteFor(sel, { fit: false });
  els.undo.disabled = !store.canUndo();
  els.redo.disabled = !store.canRedo();
};

// ---------- exportar / importar ----------

const slug = (s) =>
  s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'viaje';

const exportJson = async () => {
  const v = trip();
  if (!v) return;
  const m = v.meta;
  const data = {
    app: 'travel-42uy',
    version: 2,
    trip: { name: m.name, start: m.start, end: m.end, base: m.base },
    exportedAt: new Date().toISOString(),
    // Sin campos de sincronización (rev/updatedAt/…): el export es portable.
    activities: alive(v.activities).map(exportActivity),
  };
  const text = JSON.stringify(data, null, 2);
  const filename = `travel-${slug(m.name)}.json`;
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

const exportActivity = ({ id, kind, title, city, lat, lon, start, end, time, desc, photos }) =>
  ({ id, kind, title, city, lat, lon, start, end, time: time ?? '', desc, photos });

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

const validActivity = (a) => {
  const v = trip();
  return a && typeof a === 'object' &&
    typeof a.title === 'string' && typeof a.city === 'string' &&
    typeof a.lat === 'number' && typeof a.lon === 'number' &&
    isIsoDate(a.start) && a.start >= v.meta.start && a.start <= v.meta.end &&
    (a.end == null || a.end === '' || isIsoDate(a.end)) &&
    (a.time == null || a.time === '' || isTime(a.time));
};

const sanitizeActivity = (a) => {
  const v = trip();
  const kind = KINDS[a.kind] ? a.kind : 'otro';
  return {
    id: crypto.randomUUID(),
    kind,
    title: a.title,
    city: a.city,
    lat: a.lat,
    lon: a.lon,
    start: a.start,
    end: isRangeKind(kind) && isIsoDate(a.end) && a.end !== a.start
      ? (a.end > v.meta.end ? v.meta.end : a.end) : '',
    time: !isRangeKind(kind) && isTime(a.time) ? a.time : '',
    desc: typeof a.desc === 'string' ? a.desc : '',
    photos: Array.isArray(a.photos) ? a.photos.filter((p) => typeof p === 'string' && /^https?:\/\//i.test(p)) : [],
  };
};

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
    body: `Reemplaza las paradas actuales por las ${list.length} del archivo. Podés deshacerlo con ↶.`,
    acceptLabel: 'Importar',
  });
  if (!ok) return;
  animated.clear();
  store.dispatch(makeCommand('SET_ACTIVITIES', {
    activities: list.map(sanitizeActivity),
    prev: alive(trip().activities),
  }));
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
  const v = trip();
  const acts = sorted();
  const occupied = acts.length
    ? acts.map((a) => `${a.start}${a.end ? `→${a.end}` : ''} (${a.city})`).join(', ')
    : '(ninguna por ahora)';
  return [
    `Sos mi asistente para planificar un viaje: «${v.meta.name}». Contexto:`,
    `- Estadía: del ${v.meta.start} al ${v.meta.end} (fechas fijas).`,
    `- Base: ${v.meta.base.name} — duermo ahí salvo escapadas con noche.`,
    '',
    'Trabajamos en tres pasos:',
    '',
    '1) ENTREVISTA. Antes de proponer nada, conoceme: haceme UNA sola pregunta por vez (corta, con opciones si ayuda) sobre qué me gusta y qué tengo ganas de hacer en este viaje: intereses (museos, comida, naturaleza, fotografía, teatro, música…), ritmo (relajado o intenso), con quién viajo, presupuesto, y lo que te parezca relevante. Esperá mi respuesta antes de la siguiente pregunta. Con 5 o 6 respuestas alcanza; si escribo «listo», pasá al paso 2.',
    '',
    '2) IDEAS. Con lo que sabés de mí, proponé actividades concretas en texto normal (todavía NO JSON): qué, en qué ciudad, qué día u horario conviene y por qué me puede gustar. Yo te voy a ir pidiendo cambios: alternativas, sacar o sumar cosas, ajustar fechas u horarios. Iteramos hasta que la lista me cierre. No hace falta llenar todos los días: lo que exportes se AGREGA a lo que ya tengo en la app, así que incluí solo lo que acordamos.',
    '',
    '3) EXPORTAR. Cuando yo escriba «exportar», respondé ÚNICAMENTE con un JSON válido (sin markdown, sin texto extra) con exactamente esta forma:',
    '',
    '{"app":"travel-42uy","version":2,"activities":[{"title":"Escapada a la costa","kind":"viaje","city":"Benidorm","lat":38.5342,"lon":-0.1314,"start":"2026-12-10","end":"2026-12-13","time":"","desc":"Playa y casco antiguo.","photos":[]},{"title":"Museo del Prado","kind":"museo","city":"Madrid","lat":40.4138,"lon":-3.6921,"start":"2026-12-14","end":"","time":"10:30","desc":"Colección permanente.","photos":[]}]}',
    '',
    'Reglas del JSON:',
    '- "kind" es uno de: "viaje", "museo", "foto", "comida", "teatro", "recital", "otro".',
    '- "start"/"end" en formato YYYY-MM-DD, dentro del viaje. Si es por el día, "end":"".',
    '- Solo "viaje" y "otro" pueden tener "end"; el resto lleva "end":"" y opcionalmente "time":"HH:MM" (24 h).',
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
    if (isEditableTarget(document.activeElement) || els.dlgForm.open || els.dlgVacForm.open) {
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

  tripMap.initMap($('map'));

  els.fab.onclick = () => openForm(null);
  $('btn-view-list').onclick = () => setView('list');
  $('btn-view-cal').onclick = () => setView('cal');
  els.undo.onclick = () => store.undo();
  els.redo.onclick = () => store.redo();

  els.btnVacations.onclick = () => showSplash();
  $('btn-log').onclick = () => { els.dlgTools.close(); openLogDrawer(); };
  const dlgLog = $('dlg-log');
  dlgLog.onclick = (ev) => { if (ev.target === dlgLog) dlgLog.close(); };
  $('btn-welcome-new').onclick = () => openVacForm();
  $('btn-vac-cancel').onclick = () => els.dlgVacForm.close();

  els.fabTools.onclick = () => els.dlgTools.showModal();
  els.dlgTools.onclick = (ev) => { if (ev.target === els.dlgTools) els.dlgTools.close(); };
  $('btn-export').onclick = () => { els.dlgTools.close(); exportJson(); };
  $('btn-banner-export').onclick = () => exportJson();
  $('btn-import').onclick = () => { els.dlgTools.close(); els.fileImport.click(); };
  $('btn-gpt').onclick = () => { els.dlgTools.close(); openGptDialog(); };

  const dlgPhoto = $('dlg-photo');
  dlgPhoto.onclick = () => dlgPhoto.close();
  $('btn-photo-close').onclick = () => dlgPhoto.close();

  const dlgDay = $('dlg-day');
  dlgDay.onclick = (ev) => { if (ev.target === dlgDay) dlgDay.close(); };
  dlgDay.addEventListener('close', () => {
    if (selectedDay) { selectedDay = null; if (viewMode === 'cal') renderCalendar(); }
  });

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
  els.fileAttach.onchange = () => {
    const file = els.fileAttach.files?.[0];
    els.fileAttach.value = '';
    if (file && attachTargetId) attachFile(attachTargetId, file);
    attachTargetId = null;
  };

  window.addEventListener('keydown', onKeyDown);
  wireSwReload();
  initShare();

  // Sin hideSplash: el diálogo (top layer) se ve sobre el mosaico y el
  // splash se cierra solo cuando el viaje nuevo pasa a ser el activo.
  // Cancelar te deja en el dashboard.
  $('btn-splash-new').onclick = () => openVacForm();

  store.subscribe(render);
  render();
  showSplash();
  requestAnimationFrame(() => tripMap.invalidateSize());
};

start();
