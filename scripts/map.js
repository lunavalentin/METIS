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
      this.layerControl = L.control.layers({ Plan: muted, OSM: osm, Satellite: sat }, {}, { collapsed: true }).addTo(this.map);
    }

    for (const ly of config.layers) {
      const ov = this.mode === 'plan'
        ? L.imageOverlay(ly.url, ly.bounds, { opacity: ly.opacity ?? 1 })
        : new RotatedOverlay(ly.url, placementBounds(ly.placement), { opacity: ly.opacity ?? 1, rotationDeg: ly.placement.rotationDeg });
      ov.metis = ly;
      this.overlays.push(ov);
      this.layerControl?.addOverlay(ov, tr(ly.label));
    }

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.layerControl?.setPosition('bottomright');
    this.markers.addTo(this.map);
    this.onPointClick = onPointClick;
    this.map.on('click', e => onMapClick?.(this.toPointCoords(e.latlng)));
    this.setFloor(this.floor);
  }

  toPointCoords(latlng) {
    return this.mode === 'plan' ? { x: latlng.lng, y: latlng.lat, floor: this.floor } : { lat: latlng.lat, lng: latlng.lng, floor: this.floor };
  }

  setFloor(floorId) {
    this.floor = floorId;
    for (const ov of this.overlays) {
      if (ov.metis.floor === floorId) ov.addTo(this.map); else ov.remove();
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
