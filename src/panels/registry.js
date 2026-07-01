// ── Lazy panel registry ─────────────────────────────────────────────────────
// Memoized dynamic imports so these panels split out of the main bundle and load
// on first use. SAFE because each is reached ONLY through dispatchers defined in
// main.js (the nav loader map + the show*/openModal globals) and none is invoked
// via a stomped cross-panel window.* global.
//
// NOTE: the sacramental / marriage / annulment / ocia cluster is deliberately
// NOT here — those panels share window.expand* globals (e.g. expandCase is
// defined by three panels) and are cross-linked via non-optional onclick="…"
// handlers, so they need live cross-link regression testing before lazy-loading.
// They stay eager for now.

const loaders = {
  admin:                () => import('./admin.js'),
  hr:                   () => import('./hr.js'),
  projects:             () => import('./projects.js'),
  projectDashboard:     () => import('./projectDashboard.js'),
  teamDashboard:        () => import('./teamDashboard.js'),
  institutionDashboard: () => import('./institutionDashboard.js'),
  school:               () => import('./school.js'),
  discernment:          () => import('./discernment.js'),
  homebound:            () => import('./homebound.js'),
  youthministry:        () => import('./youthministry.js'),
  // Sacramental cluster — each panel owns exactly one expand* global (defined
  // once; marriage/ocia only re-expose annulments' expandCase). Lazy-loadable
  // because main.js installs ensure-load stubs for those globals, so a cross-link
  // click loads the owning panel before invoking it. (marriage + ocia statically
  // import annulments, so they naturally share a chunk.)
  marriage:             () => import('./marriage.js'),
  annulments:           () => import('./annulments.js'),
  ocia:                 () => import('./ocia.js'),
  baptism:              () => import('./baptism.js'),
  firstcomm:            () => import('./firstcomm.js'),
  confirmation:         () => import('./confirmation.js'),
};

const cache = {};

// Returns a promise resolving to the panel module (memoized). Unknown names
// resolve to null so callers can no-op safely.
export function ensurePanel(name) {
  if (!loaders[name]) return Promise.resolve(null);
  if (!cache[name]) cache[name] = loaders[name]();
  return cache[name];
}
