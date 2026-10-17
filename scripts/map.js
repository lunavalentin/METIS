// Leaflet map: geo (OSM / satellite) or plan (local metres, CRS.Simple); floor plans as
// georeferenced overlays placed by centre + size in metres + rotation; floor switcher; markers.
import { tr } from './i18n.js';

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
function placementBounds({ center: [lat, lng], widthM, heightM }) {
  const dLat = heightM / 2 / 110540;
  const dLng = widthM / 2 / (111320 * Math.cos(lat * Math.PI / 180));
  return [[lat - dLat, lng - dLng], [lat + dLat, lng + dLng]];
}

// Bottom-right button that flies back to the project's home view.
const RecenterControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const el = L.DomUtil.create('div', 'leaflet-bar metis-recenter');
    el.innerHTML = `<a href="#" role="button" title="Recentrer / Recenter" aria-label="Recenter">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></a>`;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.on(el.firstChild, 'click', e => { L.DomEvent.preventDefault(e); this.options.onClick(); });
    return el;
  },
});

// Tooltip strings are rendered as HTML by Leaflet; names come from users.
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const TYPE_COLORS = { pano: '#d9480f', ir: '#1971c2', audio: '#0ca678', photo: '#ae3ec9', video: '#e8590c', text: '#495057' };

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
      // "Plan" = OSM tiles muted by a CSS filter (.tiles-muted in index.html): modern look, no API key.
      const osmOpts = { maxNativeZoom: 19, maxZoom: 22, attribution: '© OpenStreetMap contributors' };
      const muted = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { ...osmOpts, className: 'tiles-muted' }).addTo(this.map);
      const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', osmOpts);
      const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 19, maxZoom: 22, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      });
      this.baseLayers = { Plan: muted, OSM: osm, Satellite: sat };
      this.layerControl = L.control.layers(this.baseLayers, {}, { collapsed: true }).addTo(this.map);
    }

    for (const ly of config.layers) {
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
    }

    new RecenterControl({ onClick: () => this.recenter() }).addTo(this.map);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.layerControl?.setPosition('bottomright');
    this.markers.addTo(this.map);
    this.onPointClick = onPointClick;
    this.map.on('click', e => onMapClick?.(this.toPointCoords(e.latlng)));
    this.setFloor(this.floor);
  }

  recenter() {
    if (this.mode === 'plan') {
      const { xmax, ymax } = this.config.map.planBounds;
      this.map.flyToBounds([[0, 0], [ymax, xmax]], { duration: 0.6 });
    } else {
      this.map.flyTo(this.config.map.center, this.config.map.zoom, { duration: 0.6 });
    }
  }

  // Placement helper (geo mode): open the site with ?align=<layerId>. Drag the centre handle, adjust rotation,
  // width and opacity, then copy the JSON into config.json → layers[].placement.
  startAlign(layerId) {
    const ov = this.overlays.find(o => o.metis.id === layerId);
    if (!ov || this.mode !== 'geo') return false;
    this.setFloor(ov.metis.floor);
    this.baseLayers.Plan.remove(); this.baseLayers.Satellite.addTo(this.map); // align against real roofs
    this.map.fitBounds(L.latLngBounds(placementBounds(ov.metis.placement)), { padding: [40, 40] });
    const p = structuredClone(ov.metis.placement);
    const img = new Image();
    img.src = ov.metis.url;
    const ratio = () => (img.naturalWidth ? img.naturalHeight / img.naturalWidth : p.heightM / p.widthM);
    const handle = L.marker(p.center, {
      draggable: true, zIndexOffset: 1000,
      icon: L.divIcon({ className: 'align-handle', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(this.map);
    const panel = L.DomUtil.create('div', 'align-panel', this.map.getContainer());
    L.DomEvent.disableClickPropagation(panel); L.DomEvent.disableScrollPropagation(panel);
    panel.innerHTML = `
      <strong>Align · ${escapeHtml(layerId)}</strong>
      <label>Rotation <output data-o="rot"></output>°<input type="range" data-k="rot" min="-180" max="180" step="0.25"></label>
      <label>Width <output data-o="w"></output> m<input type="range" data-k="w" min="10" max="500" step="0.25"></label>
      <label>Opacity<input type="range" data-k="op" min="0.1" max="1" step="0.05"></label>
      <textarea readonly rows="4"></textarea>
      <button type="button">Copy JSON</button>`;
    const q = sel => panel.querySelector(sel);
    q('[data-k=rot]').value = p.rotationDeg; q('[data-k=w]').value = p.widthM; q('[data-k=op]').value = ov.options.opacity;
    const r4 = v => Math.round(v * 1e6) / 1e6;
    const apply = () => {
      p.rotationDeg = Number(q('[data-k=rot]').value);
      p.widthM = Number(q('[data-k=w]').value);
      p.heightM = Math.round(p.widthM * ratio() * 100) / 100;
      const ll = handle.getLatLng(); p.center = [r4(ll.lat), r4(ll.lng)];
      ov.options.rotationDeg = p.rotationDeg;
      ov.setBounds(L.latLngBounds(placementBounds(p)));
      ov.setOpacity(Number(q('[data-k=op]').value));
      q('[data-o=rot]').textContent = p.rotationDeg; q('[data-o=w]').textContent = p.widthM;
      q('textarea').value = JSON.stringify({ placement: p });
    };
    panel.querySelectorAll('input').forEach(i => i.addEventListener('input', apply));
    handle.on('drag', apply);
    img.onload = apply;
    q('button').onclick = () => navigator.clipboard?.writeText(q('textarea').value);
    apply();
    return true;
  }

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
      const color = TYPE_COLORS[types.find(t => TYPE_COLORS[t])] || '#868e96';
      const icon = L.divIcon({
        className: 'metis-pin',
        html: `<span style="--c:${color}"${types.length ? '' : ' class="pin-empty"'}>${types.length || ''}</span>`,
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
