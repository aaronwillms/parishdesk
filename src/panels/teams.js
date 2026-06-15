import { sb } from '../supabase.js';
import { store } from '../store.js';

let allTeams = [];

// ── Data ───────────────────────────────────────────────────────────────────

export async function loadTeamsStore() {
  const { data, error } = await sb.from('teams').select('id,name').order('name');
  if (error) console.error('[teams] store load error:', error);
  store.teams = data || [];
}

export async function loadTeams() {
  const [{ data: teamsData, error: teamsErr }, { data: membersData, error: membersErr }] = await Promise.all([
    sb.from('teams').select('*').order('sort_order', { nullsFirst: false }).order('name'),
    sb.from('team_members').select('id,team_id').order('id'),
  ]);
  if (teamsErr)   console.error('[teams] load error:', teamsErr);
  if (membersErr) console.error('[team_members] load error:', membersErr);

  const members = membersData || [];
  allTeams = (teamsData || []).map(t => ({
    ...t,
    memberCount: members.filter(m => m.team_id === t.id).length,
  }));
  store.teams = allTeams.map(({ id, name }) => ({ id, name }));
  renderTeamsLanding();
  updateTeamsSubNav();
}

// ── Landing render ─────────────────────────────────────────────────────────

function renderTeamsLanding() {
  const el = document.getElementById('teams-list');
  if (!el) return;

  if (!allTeams.length) {
    el.innerHTML = '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No teams yet. Use the button above to create one.</div>';
    return;
  }

  el.innerHTML = allTeams.map(t => `
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
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:700;color:#1C2B3A;line-height:1.2;">${t.name}</div>
          ${t.description ? `<div style="font-size:13px;color:#6B7280;margin-top:4px;line-height:1.45;">${t.description}</div>` : ''}
          <div style="font-size:11.5px;color:#9CA3AF;margin-top:6px;font-weight:500;">${t.memberCount} member${t.memberCount !== 1 ? 's' : ''}</div>
        </div>
        <span style="color:#C9A84C;font-size:18px;margin-top:2px;flex-shrink:0;">›</span>
      </div>
    </div>
  `).join('');
}

// ── Sub-nav update (called after load and after dashboard navigation) ───────

export function updateTeamsSubNav() {
  const subNav = document.getElementById('teams-subnav');
  if (!subNav) return;
  subNav.innerHTML = allTeams.map(t => `
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

function teamSettingsForm(t) {
  return `<div class="modal-title">${t ? 'Edit team — ' + t.name : 'New team'}</div>
  <label>Team name</label><input id="tf-name" value="${t?.name || ''}" placeholder="e.g. Finance Council" />
  <label>Description</label><textarea id="tf-desc" rows="2">${t?.description || ''}</textarea>
  <label>Sort order</label><input type="number" id="tf-sort" value="${t?.sort_order ?? ''}" placeholder="e.g. 1" />
  <div class="modal-actions" style="justify-content:space-between;">
    ${t ? `<button class="btn-delete" onclick="deleteTeam('${t.id}')">Delete team</button>` : '<span></span>'}
    <div style="display:flex;gap:8px;">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveTeam(${t ? `'${t.id}'` : null})">Save</button>
    </div>
  </div>`;
}

async function saveTeam(id) {
  const name = document.getElementById('tf-name').value.trim();
  if (!name) { alert('Team name is required.'); return; }
  const payload = {
    name,
    description: document.getElementById('tf-desc').value.trim() || null,
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
  closeModal();
  await loadTeams();
}

async function deleteTeam(id) {
  const t = allTeams.find(x => x.id === id);
  if (!confirm(`Delete "${t?.name}"? This will also remove all members. This cannot be undone.`)) return;
  const { error } = await sb.from('teams').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  closeModal();
  await loadTeams();
}

Object.assign(window, { openAddTeam, saveTeam, deleteTeam, openTeamSettings });
