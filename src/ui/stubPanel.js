// Renders a "Coming Soon" placeholder into a container element.
// stubPanel('homebound-root', { icon, title, blurb })
export function stubPanel(containerId, { icon = 'fa-screwdriver-wrench', title = 'Coming Soon', blurb = '' } = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <div class="card" style="max-width:560px;margin:2rem auto;text-align:center;padding:2.5rem 1.75rem;">
      <div style="width:64px;height:64px;border-radius:50%;background:rgba(201,168,76,.14);display:flex;align-items:center;justify-content:center;margin:0 auto 1.1rem;">
        <i class="fa-solid ${icon}" style="font-size:26px;color:var(--gold);"></i>
      </div>
      <div style="font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:600;color:var(--navy);margin-bottom:.35rem;">${title}</div>
      <div style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);background:rgba(201,168,76,.12);border-radius:20px;padding:3px 12px;margin-bottom:1rem;">Coming Soon</div>
      <p style="font-size:14px;line-height:1.6;color:#6B7280;margin:0;">${blurb}</p>
    </div>`;
}
