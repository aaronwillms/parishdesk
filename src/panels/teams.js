import { sb } from '../supabase.js';
import { store } from '../store.js';

let allTeams = [];       // [{ ...team, members: [{...team_member, personnel: {...}}] }]
let expandedTeamId = null;

// ── Data ───────────────────────────────────────────────────────────────────

export async function loadTeams() {
  const [{ data: teamsData, error: teamsErr }, { data: membersData, error: membersErr }] = await Promise.all([
    sb.from('teams').select('*').order('sort_order', { nullsFirst: false }).order('name'),
    sb.from('team_members').select('*, personnel(id,name,title,phone,email)').order('sort_order', { nullsFirst: false }),
  ]);
  if (teamsErr)   console.error('[teams] load error:', teamsErr);
  if (membersErr) console.error('[team_members] load error:', membersErr);

  const members = membersData || [];
  allTeams = (teamsData || []).map(t => ({
    ...t,
    members: members.filter(m => m.team_id === t.id),
  }));
  renderTeams();
}

// ── Render ─────────────────────────────────────────────────────────────────

function contactChips(p) {
  let out = '';
  if (p.phone) out += `<a href="tel:${p.phone}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">📞 ${p.phone}</a>`;
  if (p.email) out += `<a href="mailto:${p.email}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">✉️ ${p.email}</a>`;
  return out ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:3px;">${out}</div>` : '';
}

function renderTeams() {
  const el = document.getElementById('teams-list');
  if (!el) return;
  if (!allTeams.length) {
    el.innerHTML = '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No teams yet. Add one to get started.</div>';
    return;
  }
  el.innerHTML = allTeams.map(t => renderTeamCard(t)).join('');
}

function renderTeamCard(t) {
  const exp = expandedTeamId === t.id;
  let h = `<div class="card" id="team-card-${t.id}" style="margin-bottom:.75rem;">`;

  // Header row
  h += `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">`;
  h += `<div style="flex:1;cursor:pointer;" onclick="toggleTeam('${t.id}')">`;
  h += `<div style="font-size:15px;font-weight:600;color:var(--navy);">${t.name}</div>`;
  if (t.description) h += `<div style="font-size:13px;color:#6B7280;margin-top:2px;">${t.description}</div>`;
  h += `<div style="font-size:12px;color:#9CA3AF;margin-top:4px;">${t.members.length} member${t.members.length !== 1 ? 's' : ''}</div>`;
  h += `</div>`;
  h += `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">`;
  h += `<button onclick="openTeamSettings('${t.id}')" title="Team settings" style="background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:16px;padding:2px;line-height:1;" onmouseover="this.style.color='var(--navy)'" onmouseout="this.style.color='#9CA3AF'">⚙</button>`;
  h += `<span style="font-size:14px;color:#B0A090;cursor:pointer;" onclick="toggleTeam('${t.id}')">${exp ? '▲' : '▼'}</span>`;
  h += `</div></div>`;

  if (exp) {
    h += `<div style="margin-top:12px;border-top:.5px solid var(--stone);padding-top:12px;">`;

    if (t.members.length) {
      h += t.members.map(m => {
        const p = m.personnel || {};
        return `<div class="evt-item" style="cursor:default;margin-bottom:6px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
              <span style="font-weight:500;font-size:14px;color:var(--navy);">${p.name || '—'}</span>
              ${m.role ? `<span style="font-size:11px;background:#F0ECE8;color:#6B7280;border-radius:20px;padding:1px 8px;">${m.role}</span>` : ''}
            </div>
            ${p.title ? `<div style="font-size:12px;color:#6B7280;margin-top:1px;">${p.title}</div>` : ''}
            ${contactChips(p)}
          </div>
          <button onclick="removeMember('${t.id}','${m.id}')" title="Remove member" style="background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:14px;padding:0;flex-shrink:0;line-height:1;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#D1D5DB'">✕</button>
        </div>`;
      }).join('');
    } else {
      h += `<div style="font-size:13px;color:#9CA3AF;font-style:italic;margin-bottom:8px;">No members yet.</div>`;
    }

    // Add member inline picker
    h += `<div id="team-add-member-${t.id}" style="display:none;margin-top:8px;background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.65rem .75rem;">`;
    h += `<div style="font-size:12px;font-weight:600;color:#555;margin-bottom:6px;">Add member</div>`;
    const existingIds = new Set(t.members.map(m => m.personnel_id));
    const available = (store.personnel || []).filter(p => !existingIds.has(p.id)).sort((a, b) => {
      const la = (a.name || '').split(' ').pop();
      const lb = (b.name || '').split(' ').pop();
      return la.localeCompare(lb);
    });
    h += `<select id="team-person-sel-${t.id}" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;outline:none;margin-bottom:6px;">`;
    h += `<option value="">— Select person —</option>`;
    h += available.map(p => `<option value="${p.id}">${p.name}${p.title ? ' — ' + p.title : ''}</option>`).join('');
    h += `</select>`;
    h += `<input type="text" id="team-role-inp-${t.id}" placeholder="Role (e.g. Chair, Member…)" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;outline:none;margin-bottom:6px;" />`;
    h += `<div style="display:flex;gap:8px;">`;
    h += `<button class="btn-primary" style="padding:.3rem .75rem;font-size:12px;" onclick="confirmAddMember('${t.id}')">Add</button>`;
    h += `<button class="btn-secondary" style="padding:.3rem .75rem;font-size:12px;" onclick="toggleAddMember('${t.id}')">Cancel</button>`;
    h += `</div></div>`;

    h += `<button onclick="toggleAddMember('${t.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;margin-top:8px;" id="team-add-btn-${t.id}">+ Add member</button>`;
    h += `</div>`;
  }

  h += `</div>`;
  return h;
}

// ── Interactions ───────────────────────────────────────────────────────────

function toggleTeam(id) {
  expandedTeamId = expandedTeamId === id ? null : id;
  renderTeams();
}

function toggleAddMember(teamId) {
  const wrap = document.getElementById('team-add-member-' + teamId);
  const btn  = document.getElementById('team-add-btn-' + teamId);
  if (!wrap) return;
  const opening = wrap.style.display === 'none';
  wrap.style.display = opening ? 'block' : 'none';
  if (btn) btn.style.display = opening ? 'none' : 'inline';
  if (opening) document.getElementById('team-person-sel-' + teamId)?.focus();
}

async function confirmAddMember(teamId) {
  const sel  = document.getElementById('team-person-sel-' + teamId);
  const role = document.getElementById('team-role-inp-' + teamId);
  if (!sel?.value) { alert('Please select a person.'); return; }
  const { error } = await sb.from('team_members').insert({
    team_id: teamId,
    personnel_id: sel.value,
    role: role?.value.trim() || null,
  });
  if (error) { alert('Failed to add member: ' + error.message); return; }
  await loadTeams();
  expandedTeamId = teamId;
  renderTeams();
}

async function removeMember(teamId, memberId) {
  if (!confirm('Remove this member from the team?')) return;
  const { error } = await sb.from('team_members').delete().eq('id', memberId);
  if (error) { alert('Failed to remove: ' + error.message); return; }
  expandedTeamId = teamId;
  await loadTeams();
}

// ── Team settings modal ────────────────────────────────────────────────────

function openTeamSettings(id) {
  const t = allTeams.find(x => x.id === id);
  if (!t) return;
  document.getElementById('modal-content').innerHTML = teamSettingsForm(t);
  document.getElementById('modal-overlay').classList.add('open');
}

function openAddTeam() {
  document.getElementById('modal-content').innerHTML = teamSettingsForm(null);
  document.getElementById('modal-overlay').classList.add('open');
}

function teamSettingsForm(t) {
  return `<div class="modal-title">${t ? 'Edit team — ' + t.name : 'Add team'}</div>
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
  if (expandedTeamId === id) expandedTeamId = null;
  closeModal();
  await loadTeams();
}

Object.assign(window, {
  toggleTeam, toggleAddMember, confirmAddMember, removeMember,
  openTeamSettings, openAddTeam, saveTeam, deleteTeam,
});
