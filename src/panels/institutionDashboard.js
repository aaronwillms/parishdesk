import { store } from '../store.js';

let _institutionId = null;
let _activeTab = 'overview';

// ── Entry point ────────────────────────────────────────────────────────────

export function renderInstitutionDashboard(container, institutionId) {
  _institutionId = institutionId;
  _activeTab = 'overview';
  _render(container);
}

// ── Render ─────────────────────────────────────────────────────────────────

function _render(container) {
  const inst = (store.institutions || []).find(i => i.id === _institutionId);
  if (!inst) {
    container.innerHTML = '<div style="padding:2rem;color:#6B7280;">Institution not found.</div>';
    return;
  }

  const icon = inst.icon || 'fa-building';
  const personnel = (store.personnel || []).filter(p => p.institution === inst.name);
  const teams = (store.teams || []).filter(() => false); // future: filter by institution

  const tabs = [
    { id: 'overview',   label: 'Overview' },
    { id: 'directory',  label: 'Directory' },
    { id: 'teams',      label: 'Teams' },
    { id: 'projects',   label: 'Projects' },
    { id: 'documents',  label: 'Documents' },
  ];

  container.innerHTML = `
    <div style="padding:1.25rem 1.1rem 0;">
      <button onclick="window.switchPanel('dashboard')" style="
        background:none;border:none;cursor:pointer;color:#8FA8BF;
        font-size:13px;font-family:'Inter',sans-serif;padding:0;
        display:inline-flex;align-items:center;gap:5px;margin-bottom:1rem;
      " onmouseover="this.style.color='#1C2B3A'" onmouseout="this.style.color='#8FA8BF'">
        ‹ Dashboard
      </button>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:1.25rem;">
        <div style="width:48px;height:48px;background:#FDEAED;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i class="fa-solid ${icon}" style="font-size:22px;color:#8B1A2F;"></i>
        </div>
        <div>
          <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:700;color:#1C2B3A;margin:0 0 2px;">${inst.name}</h1>
          ${inst.description ? `<div style="font-size:13px;color:#6B7280;">${inst.description}</div>` : ''}
        </div>
      </div>

      <div style="display:flex;gap:0;border-bottom:.5px solid #E2DDD6;margin-bottom:1.25rem;overflow-x:auto;">
        ${tabs.map(t => `
          <button class="inst-tab" data-tab="${t.id}" onclick="window._instSwitchTab('${t.id}')" style="
            padding:.5rem 1rem;font-size:13px;font-family:'Inter',sans-serif;
            font-weight:${_activeTab === t.id ? '600' : '400'};
            color:${_activeTab === t.id ? '#1C2B3A' : '#6B7280'};
            background:none;border:none;border-bottom:2px solid ${_activeTab === t.id ? '#8B1A2F' : 'transparent'};
            cursor:pointer;white-space:nowrap;margin-bottom:-1px;
          ">${t.label}</button>
        `).join('')}
      </div>

      <div id="inst-tab-content">
        ${_tabContent(_activeTab, inst, personnel, teams)}
      </div>
    </div>
  `;

  window._instSwitchTab = (tabId) => {
    _activeTab = tabId;
    document.querySelectorAll('.inst-tab').forEach(btn => {
      const active = btn.dataset.tab === tabId;
      btn.style.fontWeight = active ? '600' : '400';
      btn.style.color = active ? '#1C2B3A' : '#6B7280';
      btn.style.borderBottom = `2px solid ${active ? '#8B1A2F' : 'transparent'}`;
    });
    const content = document.getElementById('inst-tab-content');
    if (content) content.innerHTML = _tabContent(tabId, inst, personnel, teams);
  };
}

function _tabContent(tabId, inst, personnel, teams) {
  if (tabId === 'overview')  return _overviewTab(inst, personnel, teams);
  if (tabId === 'directory') return _directoryTab(personnel);
  return _stubTab();
}

function _overviewTab(inst, personnel, teams) {
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin-bottom:1.5rem;">
      ${_statCard('Personnel', personnel.length, 'fa-users')}
      ${_statCard('Teams', teams.length, 'fa-sitemap')}
    </div>
    ${inst.description ? `
    <div class="card" style="margin-bottom:1rem;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">About</div>
      <div style="font-size:13.5px;color:#374151;line-height:1.6;">${inst.description}</div>
    </div>` : ''}
  `;
}

function _statCard(label, value, icon) {
  return `
    <div class="card" style="text-align:center;padding:1rem;">
      <i class="fa-solid ${icon}" style="font-size:20px;color:#8B1A2F;margin-bottom:.4rem;display:block;"></i>
      <div style="font-size:26px;font-weight:700;color:#1C2B3A;font-family:'Cormorant Garamond',Georgia,serif;">${value}</div>
      <div style="font-size:11.5px;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;">${label}</div>
    </div>`;
}

function _directoryTab(personnel) {
  if (!personnel.length) {
    return '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No personnel assigned to this institution.</div>';
  }

  const alpha = (a, b) => a.name.localeCompare(b.name);
  const rows = [...personnel].sort(alpha).map(p => `
    <div style="display:flex;align-items:center;gap:12px;padding:.7rem 0;border-bottom:.5px solid #F0EDE8;">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:500;font-size:14px;color:#1C2B3A;">${p.name}</div>
        ${p.title ? `<div style="font-size:12px;color:#6B7280;">${p.title}</div>` : ''}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${p.phone ? `<a href="tel:${p.phone}" style="font-size:12px;color:#8FA8BF;text-decoration:none;">📞 ${p.phone}</a>` : ''}
        ${p.email ? `<a href="mailto:${p.email}" style="font-size:12px;color:#8FA8BF;text-decoration:none;">✉️ ${p.email}</a>` : ''}
      </div>
    </div>
  `).join('');

  return `<div class="card">${rows}</div>`;
}

function _stubTab() {
  return `
    <div style="text-align:center;padding:3rem 1rem;color:#9CA3AF;">
      <i class="fa-solid fa-clock" style="font-size:28px;margin-bottom:.75rem;display:block;opacity:.4;"></i>
      <div style="font-size:14px;font-weight:500;">Coming soon</div>
      <div style="font-size:12px;margin-top:4px;">This section is under development.</div>
    </div>`;
}
