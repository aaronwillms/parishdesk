// Lightweight transient toast. showToast('message', { type, duration })
// type: 'info' (navy) | 'error' (cardinal) | 'success' (green)

const COLORS = {
  info:    '#1C2B3A',
  error:   '#8B1A2F',
  success: '#1E8449',
};

export function showToast(message, { type = 'info', duration = 4000 } = {}) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:5000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
    document.body.appendChild(host);
  }

  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = message;
  t.style.cssText = `background:${COLORS[type] || COLORS.info};color:#F8F7F4;border-radius:8px;padding:.6rem 1rem;font-size:13px;font-family:'Inter',sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.28);max-width:min(420px,90vw);text-align:center;line-height:1.4;opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;pointer-events:auto;`;
  host.appendChild(t);

  requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'none'; });
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    setTimeout(() => t.remove(), 250);
  }, duration);
}
