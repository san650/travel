// Mapa Leaflet sobre tiles de OpenStreetMap (sin API key).
// Los tiles requieren red; shell, marcadores y rutas funcionan offline.

const KIND_COLORS = {
  viaje: 'var(--k-viaje)',
  museo: 'var(--k-museo)',
  foto: 'var(--k-foto)',
  comida: 'var(--k-comida)',
  teatro: 'var(--k-teatro)',
  recital: 'var(--k-recital)',
  otro: 'var(--k-otro)',
};

let map = null;
let baseLatLng = null;
let homeMarker = null;
let markersLayer = null;
let routeLayer = null;
let markerById = new Map();
let didFit = false;

export const haversineKm = (a, b) => {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// Referencia un símbolo del sprite SVG declarado en index.html.
const svgUse = (id, size) => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
};

const pinElement = (label, kind, extraClass, offset) => {
  const el = document.createElement('div');
  el.className = 'mk' + (extraClass ? ' ' + extraClass : '');
  if (kind) el.style.setProperty('--k', KIND_COLORS[kind] || KIND_COLORS.otro);
  // `translate` (propiedad individual) se aplica antes que `rotate`/`scale`,
  // así el abanico corre en espacio de pantalla sin torcer el pin.
  if (offset) el.style.translate = `${offset[0]}px ${offset[1]}px`;
  const span = document.createElement('span');
  if (label === null) span.appendChild(svgUse('i-home', 18));
  else span.textContent = label;
  el.appendChild(span);
  return el;
};

const pinIcon = (label, kind, extraClass, offset) =>
  L.divIcon({
    html: pinElement(label, kind, extraClass, offset),
    className: '',
    iconSize: extraClass === 'mk--home' ? [34, 34] : [30, 30],
    iconAnchor: extraClass === 'mk--home' ? [17, 17] : [15, 29],
  });

export const initMap = (el) => {
  // Gestos cooperativos (como Google Maps embebido): en táctil, un dedo
  // scrollea la página y el mapa se mueve con dos (touchZoom panea y hace
  // zoom a la vez). Leaflet no lo trae: se logra apagando dragging en
  // táctil — sin la clase leaflet-touch-drag, touch-action deja pasar el
  // scroll de página al navegador.
  const coop = L.Browser.mobile;
  map = L.map(el, { zoomControl: true, attributionControl: true, dragging: !coop });
  map.setView([25, -10], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);

  if (coop) {
    const hint = document.createElement('div');
    hint.className = 'map-coop';
    hint.textContent = 'Movés el mapa con dos dedos';
    el.appendChild(hint);
    let timer = null;
    let start = null;
    el.addEventListener('touchstart', (ev) => {
      start = ev.touches.length === 1
        ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY }
        : null;
    }, { passive: true });
    el.addEventListener('touchmove', (ev) => {
      if (!start || ev.touches.length !== 1) return;
      const dx = ev.touches[0].clientX - start.x;
      const dy = ev.touches[0].clientY - start.y;
      if (Math.hypot(dx, dy) < 12) return;
      hint.classList.add('map-coop--show');
      clearTimeout(timer);
      timer = setTimeout(() => hint.classList.remove('map-coop--show'), 1100);
    }, { passive: true });
  }
};

// Mueve la base (marcador "casa") al cambiar de viaje.
export const setBase = (base) => {
  if (baseLatLng && baseLatLng.lat === base.lat && baseLatLng.lon === base.lon) return;
  baseLatLng = base;
  didFit = false;
  if (homeMarker) {
    homeMarker.setLatLng([base.lat, base.lon]);
  } else {
    homeMarker = L.marker([base.lat, base.lon], {
      icon: pinIcon(null, null, 'mk--home'),
      zIndexOffset: 500,
      keyboard: false,
    }).addTo(map);
  }
  map.setView([base.lat, base.lon], 8);
};

export const renderMarkers = (activities, activeId, onTap) => {
  markersLayer.clearLayers();
  markerById = new Map();

  // El gazetteer es a nivel ciudad: varias paradas comparten lat/lon exactas
  // y los pines quedarían perfectamente apilados. Abanico determinista en
  // píxeles alrededor del punto real para que todos se vean y se toquen.
  const groups = new Map();
  for (const act of activities) {
    const key = `${act.lat},${act.lon}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(act.id);
  }

  activities.forEach((act, i) => {
    const extra = act.id === activeId ? 'mk--active' : '';
    const group = groups.get(`${act.lat},${act.lon}`);
    let offset = null;
    if (group.length > 1) {
      const j = group.indexOf(act.id);
      const ang = (j / group.length) * 2 * Math.PI - Math.PI / 2;
      offset = [Math.round(Math.cos(ang) * 13), Math.round(Math.sin(ang) * 13)];
    }
    const m = L.marker([act.lat, act.lon], {
      icon: pinIcon(String(i + 1), act.kind, extra, offset),
      zIndexOffset: act.id === activeId ? 400 : i,
    });
    m.on('click', () => onTap(act));
    m.addTo(markersLayer);
    markerById.set(act.id, m);
  });

  // Línea punteada con el orden cronológico de las paradas.
  if (activities.length > 1) {
    L.polyline(activities.map((a) => [a.lat, a.lon]), {
      color: '#3A2C23',
      weight: 2,
      opacity: 0.45,
      dashArray: '2 7',
      interactive: false,
    }).addTo(markersLayer);
  }

  if (!didFit && activities.length && baseLatLng) {
    didFit = true;
    const bounds = L.latLngBounds([
      [baseLatLng.lat, baseLatLng.lon],
      ...activities.map((a) => [a.lat, a.lon]),
    ]);
    map.fitBounds(bounds.pad(0.2), { maxZoom: 10 });
  }
};

// Arco cuadrático entre base y destino, para que la ruta se lea como
// "recorrido" y no como una regla recta.
const arcPoints = (a, b, n = 48) => {
  const mx = (a.lat + b.lat) / 2;
  const my = (a.lon + b.lon) / 2;
  const dx = b.lat - a.lat;
  const dy = b.lon - a.lon;
  const cLat = mx - dy * 0.18;
  const cLon = my + dx * 0.18;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const lat = (1 - t) ** 2 * a.lat + 2 * (1 - t) * t * cLat + t ** 2 * b.lat;
    const lon = (1 - t) ** 2 * a.lon + 2 * (1 - t) * t * cLon + t ** 2 * b.lon;
    pts.push([lat, lon]);
  }
  return pts;
};

export const showRoute = (base, act, { fit = false } = {}) => {
  routeLayer.clearLayers();
  const line = L.polyline(arcPoints(base, { lat: act.lat, lon: act.lon }), {
    color: '#C73E1D',
    weight: 4,
    opacity: 0.9,
    className: 'route-line',
    interactive: false,
  });
  line.addTo(routeLayer);
  if (fit) map.fitBounds(line.getBounds().pad(0.2), { maxZoom: 10 });
};

export const focusOn = (points) => {
  if (!map || !points.length) return;
  if (points.length === 1) {
    map.setView([points[0].lat, points[0].lon], Math.max(map.getZoom(), 9));
  } else {
    map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon])).pad(0.3), { maxZoom: 10 });
  }
};

export const clearRoute = () => {
  if (routeLayer) routeLayer.clearLayers();
};

export const invalidateSize = () => {
  if (map) map.invalidateSize();
};
