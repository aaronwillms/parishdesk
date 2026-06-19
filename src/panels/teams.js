import { sb } from '../supabase.js';
import { store } from '../store.js';
import { isAdmin } from '../roles.js';
import { logActivity } from '../utils.js';

let allTeams = [];

const TEAM_ICONS = [
  { cls: 'fa-users',              label: 'Group' },
  { cls: 'fa-cross',              label: 'Cross' },
  { cls: 'fa-book-open',          label: 'Study' },
  { cls: 'fa-music',              label: 'Music' },
  { cls: 'fa-hand-holding-heart', label: 'Outreach' },
  { cls: 'fa-building-columns',   label: 'Council' },
  { cls: 'fa-calendar-days',      label: 'Events' },
  { cls: 'fa-star',               label: 'Featured' },
  { cls: 'fa-dollar-sign',        label: 'Finance' },
  { cls: 'fa-school',             label: 'School' },
  { cls: 'fa-fire',               label: 'Liturgy' },
  { cls: 'fa-hospital',           label: 'Healthcare' },
  { cls: 'fa-utensils',           label: 'Hospitality' },
  { cls: 'fa-file-lines',         label: 'Admin' },
  { cls: 'fa-hands-praying',      label: 'Prayer' },
  { cls: 'fa-dove',               label: 'Spirit' },
];

// ── Data ───────────────────────────────────────────────────────────────────

export async function loadTeamsStore() {
  const { data, error } = await sb.from('teams').select('id,name,icon').order('name');
  if (error) console.error('[teams] store load error:', error);
  store.teams = data || [];
}

export async function loadTeams() {
  const [{ data: teamsData, error: teamsErr }, { data: membersData, error: membersErr }] = await Promise.all([
    sb.from('teams').select('*').order('name'),
    sb.from('team_members').select('id,team_id').order('id'),
  ]);
  if (teamsErr)   console.error('[teams] load error:', teamsErr);
  if (membersErr) console.error('[team_members] load error:', membersErr);

  const members = membersData || [];
  allTeams = (teamsData || []).map(t => ({
    ...t,
    memberCount: members.filter(m => m.team_id === t.id).length,
  }));

  // Parish Staff always first, then alphabetical
  allTeams.sort((a, b) => {
    if (a.is_protected !== b.is_protected) return a.is_protected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  store.teams = allTeams.map(({ id, name, icon }) => ({ id, name, icon }));
  renderTeamsLanding();
  updateTeamsSubNav();
}

// ── Landing render ─────────────────────────────────────────────────────────

function renderTeamsLanding() {
  const el = document.getElementById('teams-list');
  if (!el) return;

  // Basic users only see teams they belong to
  const myTeamIds = new Set(store.currentUserRoles?.teamIds || []);
  const visibleTeams = isAdmin()
    ? allTeams
    : allTeams.filter(t => myTeamIds.has(t.id));

  if (!visibleTeams.length) {
    el.innerHTML = '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">You are not a member of any teams yet.</div>';
    return;
  }

  el.innerHTML = visibleTeams.map(t => {
    const icon = t.is_protected ? 'fa-church' : (t.icon || 'fa-users');
    return `
    <div class="team-landing-card" onclick="window.showTeamDashboard('${t.id}')" style="
      background:#FFFFFF;
      border:.5px solid #E2DDD6;
      border-radius:8px;
      padding:1rem 1.1rem;
      margin-bottom:.65rem;
      cursor:pointer;
      transition:box-shadow .15s, border-color .15s;
    "
    onmouseover="this.style.boxShadow='0 4px 16px rgba(28,43,58,.12)';this.style.borderColor='#C9A84C';"
    onmouseout="this.style.boxShadow='';this.style.borderColor='#E2DDD6';">
      <div style="display:flex;align-items:center;gap:14px;">
        <div style="flex-shrink:0;width:40px;text-align:center;">
          <i class="fa-solid ${icon}" style="font-size:24px;color:#8B1A2F;"></i>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:700;color:#1C2B3A;line-height:1.2;">${t.name}</div>
          ${t.description ? `<div style="font-size:13px;color:#6B7280;margin-top:2px;line-height:1.45;">${t.description}</div>` : ''}
          <div style="font-size:11.5px;color:#9CA3AF;margin-top:4px;font-weight:500;">${t.memberCount} member${t.memberCount !== 1 ? 's' : ''}</div>
        </div>
        <span style="color:#C9A84C;font-size:18px;flex-shrink:0;">›</span>
      </div>
    </div>`;
  }).join('');
}

// ── Sub-nav update ─────────────────────────────────────────────────────────

export function updateTeamsSubNav() {
  const subNav = document.getElementById('teams-subnav');
  if (!subNav) return;
  const myTeamIds = new Set(store.currentUserRoles?.teamIds || []);
  const visibleForSubNav = isAdmin() ? allTeams : allTeams.filter(t => myTeamIds.has(t.id));
  subNav.innerHTML = visibleForSubNav.map(t => `
    <div class="nav-subnav-item" data-team-id="${t.id}" onclick="window.showTeamDashboard('${t.id}')"
      style="padding:.35rem .6rem .35rem 2.4rem;font-size:12.5px;color:#8FA8BF;cursor:pointer;border-radius:4px;transition:background .12s,color .12s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
      onmouseover="if(!this.classList.contains('active')){this.style.background='rgba(255,255,255,.07)';this.style.color='#E5DDD0';}"
      onmouseout="if(!this.classList.contains('active')){this.style.background='';this.style.color='#8FA8BF';}">
      ${t.name}
    </div>
  `).join('');
}

// ── Team settings modal ────────────────────────────────────────────────────

function openTeamSettings(id) {
  const t = allTeams.find(x => x.id === id);
  if (!t || t.is_protected) return;
  document.getElementById('modal-content').innerHTML = teamSettingsForm(t);
  document.getElementById('modal-overlay').classList.add('open');
}

function openAddTeam() {
  document.getElementById('modal-content').innerHTML = teamSettingsForm(null);
  document.getElementById('modal-overlay').classList.add('open');
}

function _iconPickerHtml(currentIcon) {
  const selected = currentIcon || 'fa-users';
  return `
    <label>Icon</label>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:.85rem;">
      ${TEAM_ICONS.map(ic => {
        const isSelected = ic.cls === selected;
        return `<button type="button" class="tf-icon-btn" data-icon="${ic.cls}"
          onclick="selectTeamIcon('${ic.cls}')"
          style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:.6rem .3rem;
            border-radius:6px;cursor:pointer;font-family:'Inter',sans-serif;font-size:10px;
            color:${isSelected ? '#C9A84C' : '#6B7280'};
            border:1.5px solid ${isSelected ? '#C9A84C' : '#E2DDD6'};
            background:${isSelected ? '#FEF9E7' : '#fff'};"
          title="${ic.label}">
          <i class="fa-solid ${ic.cls}" style="font-size:15px;color:${isSelected ? '#C9A84C' : '#9CA3AF'};"></i>
          <span>${ic.label}</span>
        </button>`;
      }).join('')}
    </div>
    <input type="hidden" id="tf-icon" value="${selected}" />`;
}

function teamSettingsForm(t) {
  return `<div class="modal-title">${t ? 'Edit team — ' + t.name : 'New team'}</div>
  <label>Team name</label><input id="tf-name" value="${t?.name || ''}" placeholder="e.g. Finance Council" />
  <label>Description</label><textarea id="tf-desc" rows="2">${t?.description || ''}</textarea>
  ${_iconPickerHtml(t?.icon || null)}
  <label>Sort order</label><input type="number" id="tf-sort" value="${t?.sort_order ?? ''}" placeholder="e.g. 1" />
  <div class="modal-actions" style="justify-content:space-between;">
    ${t ? `<button class="btn-delete" onclick="deleteTeam('${t.id}')">Delete team</button>` : '<span></span>'}
    <div style="display:flex;gap:8px;">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveTeam(${t ? `'${t.id}'` : null})">Save</button>
    </div>
  </div>`;
}

window.selectTeamIcon = function(icon) {
  document.getElementById('tf-icon').value = icon;
  document.querySelectorAll('.tf-icon-btn').forEach(btn => {
    const sel = btn.dataset.icon === icon;
    btn.style.border = `1.5px solid ${sel ? '#C9A84C' : '#E2DDD6'}`;
    btn.style.background = sel ? '#FEF9E7' : '#fff';
    btn.style.color = sel ? '#C9A84C' : '#6B7280';
    btn.querySelector('i').style.color = sel ? '#C9A84C' : '#9CA3AF';
  });
};

async function saveTeam(id) {
  const name = document.getElementById('tf-name').value.trim();
  if (!name) { alert('Team name is required.'); return; }
  const payload = {
    name,
    description: document.getElementById('tf-desc').value.trim() || null,
    icon: document.getElementById('tf-icon')?.value || 'fa-users',
    sort_order: parseInt(document.getElementById('tf-sort').value) || null,
    updated_at: new Date().toISOString(),
  };
  let err;
  if (id) {
    const r = await sb.from('teams').update(payload).eq('id', id); err = r.error;
  } else {
    const r = await sb.from('teams').insert(payload); err = r.error;
  }
  if (err) { alert('Save failed: ' + err.message); return; }
  logActivity({ action: id ? 'updated team' : 'created team', entityType: 'team', entityName: payload.name, contextType: 'team', contextId: id || null });
  window.flashSavedThen(() => { closeModal(); loadTeams(); });
}

async function deleteTeam(id) {
  const t = allTeams.find(x => x.id === id);
  if (!confirm(`Delete "${t?.name}"? This will also remove all members. This cannot be undone.`)) return;
  const { error } = await sb.from('teams').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  logActivity({ action: 'deleted team', entityType: 'team', entityName: t?.name || 'Unknown' });
  closeModal();
  await loadTeams();
}

Object.assign(window, { openAddTeam, saveTeam, deleteTeam, openTeamSettings });
