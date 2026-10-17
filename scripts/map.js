// Leaflet map: geo (OSM / satellite) or plan (local metres, CRS.Simple); floor plans as
// georeferenced overlays placed by centre + size in metres + rotation; floor switcher; markers.
import { t, tr } from './i18n.js';

const L = window.L;

// Image overlay rotated around its centre. Rotation is applied in screen space, which is fine
// at building scale (Web Mercator is conformal). Re-applied after Leaflet resets the transform.
const RotatedOverlay = L.ImageOverlay.extend({
  _applyRotation() {
    const img = this._image;
    if (!img || !this.options.rotationDeg) return;
    img.style.transformOrigin = 'center center';
    img.style[L.DomUtil.TRANSFORM] += ` rotate(${this.options.rotationDeg}deg)`;
  },
  _reset() { L.ImageOverlay.prototype._reset.call(this); this._applyRotation(); },
  _animateZoom(e) { L.ImageOverlay.prototype._animateZoom.call(this, e); this._applyRotation(); },
});

// Centre + width/height in metres → lat/lng bounds of the unrotated image.
export function placementBounds({ center: [lat, lng], widthM, heightM }) {
  const dLat = heightM / 2 / 110540;
  const dLng = widthM / 2 / (111320 * Math.cos(lat * Math.PI / 180));
  return [[lat - dLat, lng - dLng], [lat + dLat, lng + dLng]];
}

// Bottom-right button that flies back to the project's home view.
const RecenterControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const el = L.DomUtil.create('div', 'leaflet-bar metis-recenter');
    el.innerHTML = `<a href="#" role="button" title="${t('recenter')}" aria-label="${t('recenter')}">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></a>`;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.on(el.firstChild, 'click', e => { L.DomEvent.preventDefault(e); this.options.onClick(); });
    return el;
  },
});

// Tooltip strings are rendered as HTML by Leaflet; names come from users.
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One hue per media type along the blue → purple → pink scale (shared by pins, tabs, cards and chips).
export const TYPE_COLORS = { photo: '#ff6fb5', video: '#e07bff', pano: '#b57bff', ir: '#5b8cff', audio: '#4fc3ff', text: '#8b7bff' };
const TYPE_ORDER = ['photo', 'video', 'pano', 'ir', 'audio', 'text'];

// Pin = ring split into one coloured segment per media type the place holds; empty places get a faint gradient ring.
function pinStyle(types) {
  const ts = TYPE_ORDER.filter(x => types.includes(x));
  if (!ts.length) return '';
  const step = 360 / ts.length;
  return `--ring: conic-gradient(${ts.map((x, i) => `${TYPE_COLORS[x]} ${i * step}deg ${(i + 1) * step}deg`).join(', ')})`;
}

// Muted OSM base shared by the project and world maps (CSS filter .tiles-muted in index.html): modern look, no API key.
function baseLayers() {
  const osmOpts = { maxNativeZoom: 19, maxZoom: 22, attribution: '© OpenStreetMap contributors' };
  return {
    Plan: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { ...osmOpts, className: 'tiles-muted' }),
    OSM: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', osmOpts),
    Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 22, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    }),
  };
}

// Removing a Leaflet map during a pan/zoom animation throws "_leaflet_pos" later: stop animations first.
function destroyMap(map) {
  try { map.stop(); map.off(); map.remove(); } catch (e) { console.warn('map remove', e); }
}

// World map: one dot per project (public ones for visitors; all of them for super-admins, private/archived marked).
export class WorldMap {
  constructor(el, projects, { onProjectClick, isAdmin = false } = {}) {
    this.map = L.map(el, { zoomControl: false, worldCopyJump: true, minZoom: 2 }).setView([35, 8], 3);
    this.base = baseLayers(); this.base.Plan.addTo(this.map);
    this.zoomCtl = L.control.zoom({ position: 'bottomright', zoomInTitle: t('zoomIn'), zoomOutTitle: t('zoomOut') }).addTo(this.map);
    this.markers = L.layerGroup().addTo(this.map);
    this.onProjectClick = onProjectClick; this.isAdmin = isAdmin;
    this.setProjects(projects);
  }
  setProjects(projects) {
    this.projects = projects;
    this.markers.clearLayers();
    const pts = [];
    for (const p of projects) {
      const c = p.map?.center; if (!c) continue;
      const cls = ['metis-world-pin', p.public ? '' : 'is-private', p.status === 'archived' ? 'is-archived' : ''].join(' ');
      const icon = L.divIcon({ className: cls, html: '<span><b></b></span>', iconSize: [34, 34], iconAnchor: [17, 17] });
      const label = `<strong>${escapeHtml(tr(p.title) || p.id)}</strong>`
        + (p.dates?.start ? `<br><small>${escapeHtml(p.dates.start)}${p.dates.end ? ' → ' + escapeHtml(p.dates.end) : ''}</small>` : '')
        + (this.isAdmin && !p.public ? `<br><small>${t('privateProject')}</small>` : '')
        + (p.status === 'archived' ? `<br><small>${t('archivedProject')}</small>` : '');
      L.marker(c, { icon, riseOnHover: true })
        .bindTooltip(label, { direction: 'top', offset: [0, -16], className: 'metis-tip world-tip' })
        .on('click', () => this.onProjectClick?.(p))
        .addTo(this.markers);
      pts.push(c);
    }
    if (pts.length === 1) this.map.setView(pts[0], 5, { animate: false });
    else if (pts.length > 1) this.map.fitBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 6, animate: false });
  }
  center() { return this.map.getCenter(); }
  destroy() { destroyMap(this.map); }
}

export class MetisMap {
  constructor(el, config, { onPointClick, onMapClick }) {
    this.config = config;
    this.mode = config.map.mode;
    this.floor = config.floors[0]?.id ?? null;
    this.overlays = [];
    this.markers = L.layerGroup();
    this.points = [];

    if (this.mode === 'plan') {
      const { xmax, ymax } = config.map.planBounds;
      this.map = L.map(el, { crs: L.CRS.Simple, minZoom: -3, zoomSnap: 0.25, zoomControl: false });
      this.map.fitBounds([[0, 0], [ymax, xmax]]);
    } else {
      this.map = L.map(el, { maxZoom: config.map.maxZoom ?? 22, zoomControl: false }).setView(config.map.center, config.map.zoom);
      this.baseLayers = baseLayers();
      const { Plan: muted, OSM: osm, Satellite: sat } = this.baseLayers;
      muted.addTo(this.map);
      this.layerControl = L.control.layers({ [t('basePlan')]: muted, OSM: osm, [t('baseSatellite')]: sat }, {}, { collapsed: true }).addTo(this.map);
    }

    for (const ly of config.layers) this.addLayer(ly);

    this.recenterCtl = new RecenterControl({ onClick: () => this.recenter() }).addTo(this.map);
    this.zoomCtl = L.control.zoom({ position: 'bottomright', zoomInTitle: t('zoomIn'), zoomOutTitle: t('zoomOut') }).addTo(this.map);
    this.layerControl?.setPosition('bottomright');
    this.markers.addTo(this.map);
    this.onPointClick = onPointClick;
    this.map.on('click', e => onMapClick?.(this.toPointCoords(e.latlng)));
    this.setFloor(this.floor);
  }

  addLayer(ly) {
    // blend "lines": dark-on-white drawings shown as light lines on the dark map (see .overlay-lines).
    // Blending only mixes with layers in the same Leaflet pane, so line drawings go into the tile pane.
    const lines = ly.blend === 'lines';
    const opts = { opacity: ly.opacity ?? 1, attribution: ly.attribution, className: lines ? 'overlay-lines' : '', ...(lines ? { pane: 'tilePane', zIndex: 10 } : {}) };
    const ov = this.mode === 'plan'
      ? L.imageOverlay(ly.url, ly.bounds, opts)
      : new RotatedOverlay(ly.url, placementBounds(ly.placement), { ...opts, rotationDeg: ly.placement.rotationDeg });
    ov.metis = ly;
    this.overlays.push(ov);
    this.layerControl?.addOverlay(ov, tr(ly.label));
    return ov;
  }

  destroy() { destroyMap(this.map); }
  view() { const c = this.map.getCenter(); return { center: [Math.round(c.lat * 1e6) / 1e6, Math.round(c.lng * 1e6) / 1e6], zoom: Math.round(this.map.getZoom()) }; }

  // Re-create the controls whose labels come from i18n (called after a language switch).
  relabel() {
    if (this.layerControl) {
      this.layerControl.remove();
      this.layerControl = L.control.layers({ [t('basePlan')]: this.baseLayers.Plan, OSM: this.baseLayers.OSM, [t('baseSatellite')]: this.baseLayers.Satellite }, {}, { collapsed: true, position: 'bottomright' });
      for (const ov of this.overlays) this.layerControl.addOverlay(ov, tr(ov.metis.label));
      this.layerControl.addTo(this.map);
    }
    this.recenterCtl.remove(); this.zoomCtl.remove();
    this.recenterCtl = new RecenterControl({ onClick: () => this.recenter() }).addTo(this.map);
    this.zoomCtl = L.control.zoom({ position: 'bottomright', zoomInTitle: t('zoomIn'), zoomOutTitle: t('zoomOut') }).addTo(this.map);
    this.renderMarkers();
  }

  recenter() {
    if (this.mode === 'plan') {
      const { xmax, ymax } = this.config.map.planBounds;
      this.map.flyToBounds([[0, 0], [ymax, xmax]], { duration: 0.6 });
    } else {
      this.map.flyTo(this.config.map.center, this.config.map.zoom, { duration: 0.6 });
    }
  }

  // Placement editor (geo mode): drag the centre handle, set rotation / width / opacity on the satellite base.
  // onSave(placement, opacity) / onCancel(); without callbacks (?align=<layerId>) it offers "copy JSON" instead.
  editLayer(layerId, { onSave, onCancel } = {}) {
    const ov = this.overlays.find(o => o.metis.id === layerId);
    if (!ov || this.mode !== 'geo') return false;
    this.setFloor(ov.metis.floor);
    const usedPlan = this.map.hasLayer(this.baseLayers.Plan);
    this.baseLayers.Plan.remove(); this.baseLayers.Satellite.addTo(this.map); // align against real roofs
    this.map.fitBounds(L.latLngBounds(placementBounds(ov.metis.placement)), { padding: [60, 60] });
    const p = structuredClone(ov.metis.placement);
    const img = new Image();
    img.src = ov.metis.url;
    const startRatio = p.heightM / p.widthM;      // until the image has loaded, keep the stored aspect ratio
    const ratio = () => (img.naturalWidth ? img.naturalHeight / img.naturalWidth : startRatio);
    const handle = L.marker(p.center, {
      draggable: true, zIndexOffset: 1000,
      icon: L.divIcon({ className: 'align-handle', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(this.map);
    const panel = L.DomUtil.create('div', 'align-panel', this.map.getContainer());
    L.DomEvent.disableClickPropagation(panel); L.DomEvent.disableScrollPropagation(panel);
    const editing = !!onSave;
    panel.innerHTML = `
      <strong>${t('alignTitle')} · ${escapeHtml(tr(ov.metis.label) || layerId)}</strong>
      <p class="hint small">${t('alignHint')}</p>
      <label>${t('alignRotation')} <output data-o="rot"></output>°<input type="range" data-k="rot" min="-180" max="180" step="0.25"></label>
      <label>${t('alignWidth')} <output data-o="w"></output> m<input type="range" data-k="w" min="5" max="800" step="0.25"></label>
      <label>${t('alignOpacity')}<input type="range" data-k="op" min="0.1" max="1" step="0.05"></label>
      ${editing ? `<div class="row-actions"><button type="button" data-cancel>${t('cancel')}</button><button type="button" class="grad" data-save>${t('save')}</button></div>`
        : `<textarea readonly rows="4"></textarea><button type="button" data-copy>${t('alignCopy')}</button>`}`;
    const q = sel => panel.querySelector(sel);
    const orig = { placement: structuredClone(ov.metis.placement), opacity: ov.options.opacity };
    q('[data-k=rot]').value = p.rotationDeg; q('[data-k=w]').value = p.widthM; q('[data-k=op]').value = ov.options.opacity;
    const r6 = v => Math.round(v * 1e6) / 1e6;
    const apply = () => {
      p.rotationDeg = Number(q('[data-k=rot]').value);
      p.widthM = Number(q('[data-k=w]').value);
      p.heightM = Math.round(p.widthM * ratio() * 100) / 100;
      const ll = handle.getLatLng(); p.center = [r6(ll.lat), r6(ll.lng)];
      ov.options.rotationDeg = p.rotationDeg;
      ov.setBounds(L.latLngBounds(placementBounds(p)));
      ov.setOpacity(Number(q('[data-k=op]').value));
      q('[data-o=rot]').textContent = p.rotationDeg; q('[data-o=w]').textContent = p.widthM;
      if (!editing) q('textarea').value = JSON.stringify({ placement: p });
    };
    const finish = () => {
      handle.remove(); panel.remove();
      this.baseLayers.Satellite.remove(); if (usedPlan) this.baseLayers.Plan.addTo(this.map);
    };
    panel.querySelectorAll('input').forEach(i => i.addEventListener('input', apply));
    handle.on('drag', apply);
    img.onload = apply;
    q('[data-copy]')?.addEventListener('click', () => navigator.clipboard?.writeText(q('textarea').value));
    q('[data-save]')?.addEventListener('click', () => { finish(); ov.metis.placement = structuredClone(p); ov.metis.opacity = ov.options.opacity; onSave(structuredClone(p), ov.options.opacity); });
    q('[data-cancel]')?.addEventListener('click', () => {
      finish(); ov.options.rotationDeg = orig.placement.rotationDeg;
      ov.setBounds(L.latLngBounds(placementBounds(orig.placement))); ov.setOpacity(orig.opacity); onCancel?.();
    });
    apply();
    return true;
  }
  startAlign(layerId) { return this.editLayer(layerId); }

  toPointCoords(latlng) {
    return this.mode === 'plan' ? { x: latlng.lng, y: latlng.lat, floor: this.floor } : { lat: latlng.lat, lng: latlng.lng, floor: this.floor };
  }

  // focus: when the level has a plan, zoom in on it (config.map.levelZoom, default 19) so thin lines stay readable.
  setFloor(floorId, { focus = false } = {}) {
    this.floor = floorId;
    const shown = [];
    for (const ov of this.overlays) {
      if (ov.metis.floor === floorId) { ov.addTo(this.map); shown.push(ov); } else ov.remove();
    }
    if (focus && shown.length && this.mode === 'geo') {
      const z = Math.max(this.map.getZoom(), this.config.map.levelZoom ?? 19);
      this.map.flyTo(shown[0].metis.placement.center, z, { duration: 0.6 });
    }
    this.renderMarkers();
  }

  setPoints(points) { this.points = points; this.renderMarkers(); }

  renderMarkers() {
    this.markers.clearLayers();
    for (const p of this.points) {
      if (p.hidden || (p.floor ?? null) !== this.floor) continue;
      const ll = this.mode === 'plan' ? [p.y, p.x] : [p.lat, p.lng];
      const types = p.types || [];
      const icon = L.divIcon({
        className: 'metis-pin',
        html: `<span style="${pinStyle(types)}"${types.length ? '' : ' class="pin-empty"'}><b></b></span>`,
        iconSize: [30, 30], iconAnchor: [15, 15],
      });
      L.marker(ll, { icon, riseOnHover: true })
        .bindTooltip(escapeHtml(p.name), { direction: 'top', offset: [0, -14], className: 'metis-tip' })
        .on('click', e => { L.DomEvent.stopPropagation(e); this.onPointClick?.(p); })
        .addTo(this.markers);
    }
  }

  setCursorMode(adding) { this.map.getContainer().style.cursor = adding ? 'crosshair' : ''; }
}
