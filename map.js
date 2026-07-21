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

const pinElement = (label, kind, extraClass) => {
  const el = document.createElement('div');
  el.className = 'mk' + (extraClass ? ' ' + extraClass : '');
  if (kind) el.style.setProperty('--k', KIND_COLORS[kind] || KIND_COLORS.otro);
  const span = document.createElement('span');
  if (label === null) span.appendChild(svgUse('i-home', 18));
  else span.textContent = label;
  el.appendChild(span);
  return el;
};

const pinIcon = (label, kind, extraClass) =>
  L.divIcon({
    html: pinElement(label, kind, extraClass),
    className: '',
    iconSize: extraClass === 'mk--home' ? [34, 34] : [30, 30],
    iconAnchor: extraClass === 'mk--home' ? [17, 17] : [15, 29],
  });

export const initMap = (el, base) => {
  baseLatLng = base;
  map = L.map(el, { zoomControl: true, attributionControl: true });
  map.setView([base.lat, base.lon], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  L.marker([base.lat, base.lon], {
    icon: pinIcon(null, null, 'mk--home'),
    zIndexOffset: 500,
    keyboard: false,
  }).addTo(map);
};

export const renderMarkers = (activities, activeId, onTap) => {
  markersLayer.clearLayers();
  markerById = new Map();

  activities.forEach((act, i) => {
    const extra = act.id === activeId ? 'mk--active' : '';
    const m = L.marker([act.lat, act.lon], {
      icon: pinIcon(String(i + 1), act.kind, extra),
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

  if (!didFit && activities.length) {
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

export const clearRoute = () => {
  if (routeLayer) routeLayer.clearLayers();
};

export const invalidateSize = () => {
  if (map) map.invalidateSize();
};
