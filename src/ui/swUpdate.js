// PWA update affordance — the SINGLE reload path.
//
// Replaces the old autoUpdate → controllerchange auto-reload, which activated a
// new service worker on every deploy and reloaded open tabs with no user action.
// Under registerType: 'prompt' the new SW WAITS; virtual:pwa-register calls
// onNeedRefresh ONLY for a genuine update (first install fires onOfflineReady
// instead, so it neither prompts nor reloads). The reload listener is armed
// inside updateSW(), i.e. only after the user clicks Reload — so there is exactly
// one reload, user-initiated, with the first-install exemption preserved.
//
// Stale-bundle guarantee is kept: the deployed bundle is still adopted — just on
// the user's click rather than silently mid-session.
import { registerSW } from 'virtual:pwa-register';

export function initSWUpdate() {
  if (!('serviceWorker' in navigator)) return;

  const updateSW = registerSW({
    onNeedRefresh() {
      _showUpdateBanner(() => updateSW(true)); // triggers skipWaiting + reload
    },
    // onOfflineReady: intentionally silent — no UI needed for "ready offline".
  });
}

function _showUpdateBanner(onReload) {
  if (document.getElementById('sw-update-banner')) return;

  const bar = document.createElement('div');
  bar.id = 'sw-update-banner';
  bar.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
    'z-index:6000', 'display:flex', 'align-items:center', 'gap:12px',
    'background:#1C2B3A', 'color:#F8F7F4', 'border-radius:10px',
    'padding:.6rem .75rem .6rem 1rem', 'font-size:13px',
    "font-family:'Inter',sans-serif", 'box-shadow:0 6px 22px rgba(0,0,0,.3)',
    'max-width:min(440px,92vw)',
  ].join(';');

  bar.innerHTML = `
    <span style="line-height:1.3;">A new version is available.</span>
    <button id="sw-update-reload" style="
      background:#C9A84C;color:#1C2B3A;border:none;border-radius:6px;
      padding:.35rem .8rem;font-size:12.5px;font-weight:600;
      font-family:'Inter',sans-serif;cursor:pointer;white-space:nowrap;
    ">Reload</button>
    <button id="sw-update-dismiss" aria-label="Dismiss" title="Dismiss" style="
      background:none;border:none;color:#9CA3AF;font-size:18px;line-height:1;
      cursor:pointer;padding:0 2px;
    ">&times;</button>`;

  document.body.appendChild(bar);

  document.getElementById('sw-update-reload')?.addEventListener('click', () => {
    const btn = document.getElementById('sw-update-reload');
    if (btn) { btn.textContent = 'Updating…'; btn.disabled = true; }
    onReload();
  });
  // Dismiss lets the user keep working on the current bundle; the waiting SW
  // stays parked and the prompt re-appears on the next load/update check.
  document.getElementById('sw-update-dismiss')?.addEventListener('click', () => bar.remove());
}
