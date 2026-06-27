// ── Admin-initiated invite (Build 1) ─────────────────────────────────────────
// Relocated from the Admin > Invite User tab to the fa-user-plus launcher in the
// top bar. A role-tiered modal: every inviter (admin + super_admin) can set an
// email + an OPTIONAL link (directory contact) + parish placement; super-admins
// additionally get the full grant matrix.
//
// The auth.users row exists at invite-SEND (GoTrue admin/invite, returned by
// /invite-user as { userId } — see functions/invite-user.js), so the pre-fill
// writes link/place/grant rows against that user_id IMMEDIATELY — no holding
// mechanism. This is a fresh, INSERT-ONLY save: a brand-new invitee has no
// existing rows, so there is no masking/locking/diffing (unlike admin.js's
// _saveUser, which edits an existing user's masked state — deliberately NOT reused).
import { sb } from '../supabase.js';
import { store } from '../store.js';
import { isSuperAdmin } from '../roles.js';
import { createContactPicker } from './contactPicker.js';

// Grant-matrix shape, mirrored from admin.js (kept local — same keys/labels).
const SACRAMENTS = ['baptism', 'first_communion', 'confirmation', 'ocia', 'marriage', 'annulments'];
const SACRAMENT_LABELS = { baptism: 'Baptism', first_communion: 'First Communion', confirmation: 'Confirmation', ocia: 'OCIA', marriage: 'Marriage', annulments: 'Annulments' };
const PANEL_LABELS = { school: 'Cathedral School', discernment: 'Discernment', homebound: 'Sick & Homebound' };
// prep-vs-cura key set (matches ui/programCoordinators.js): prep keys stamp the
// chosen parish_id, cura/other → NULL.
const PREP_PROGRAMS = new Set(['baptism', 'firstcomm', 'first_communion', 'confirmation', 'ocia', 'marriage']);

let _selectedPerson = null;
let _launcherWired = false;

// Wire the top-bar launcher once. Visibility is handled by applyNavVisibility().
export function initInviteLauncher() {
  if (_launcherWired) return;
  const launcher = document.getElementById('invite-launcher');
  if (!launcher) return;
  launcher.addEventListener('click', openInvitePanel);
  _launcherWired = true;
}

export function openInvitePanel() {
  const content = document.getElementById('modal-content');
  const overlay = document.getElementById('modal-overlay');
  if (!content || !overlay) return;

  _selectedPerson = null;
  const superA       = isSuperAdmin();
  const groupParishes = store.groupParishes || [];
  const multiParish  = groupParishes.length > 1;
  const curParishId  = store.parishSettings?.id || '';

  const sectionLabel = 'font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;';

  const parishBlock = multiParish ? `
    <div style="margin-top:1rem;">
      <div style="${sectionLabel}">Parish Placement</div>
      <select id="inv-parish-select" style="
        padding:.4rem .65rem;border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;
        font-family:'Inter',sans-serif;outline:none;cursor:pointer;background:#fff;min-width:220px;
      ">
        ${groupParishes.map(p => `<option value="${p.id}" ${p.id === curParishId ? 'selected' : ''}>${(p.parish_name || p.display_name || 'Parish').replace(/</g, '&lt;')}</option>`).join('')}
      </select>
      <div style="font-size:11.5px;color:#9CA3AF;margin-top:4px;line-height:1.5;">Where this user is placed (link) and which parish's prep panels are granted. Cura/group-wide grants ignore this.</div>
    </div>` : '';

  // Grant matrix — SUPER-ADMIN ONLY. Plain admins never see this section.
  const cb = (cls, dataAttr, label) => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <input type="checkbox" class="${cls}" ${dataAttr}
        style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:pointer;flex-shrink:0;" />
      <span style="font-size:13px;color:#1C2B3A;">${label}</span>
    </div>`;
  const grantBlock = superA ? `
    <div style="margin-top:1rem;border-top:.5px solid #F0EDE8;padding-top:1rem;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;">
        <div>
          <div style="${sectionLabel}">Sacramental Roles</div>
          ${SACRAMENTS.map(s => cb('inv-sac-cb', `data-sacrament="${s}"`, SACRAMENT_LABELS[s])).join('')}
        </div>
        <div>
          <div style="${sectionLabel}">Panel Grants</div>
          ${Object.entries(PANEL_LABELS).map(([p, label]) => cb('inv-grant-cb', `data-panel="${p}"`, label)).join('')}
        </div>
      </div>
    </div>` : '';

  content.innerHTML = `
    <div class="modal-title">Invite New User</div>
    <label for="inv-email">Email address</label>
    <input id="inv-email" type="email" placeholder="name@parish.org" autocomplete="off" />

    <div style="margin-top:1.25rem;border-top:.5px solid #F0EDE8;padding-top:1rem;">
      <div style="${sectionLabel}">Optional Pre-fill</div>
      <div style="font-size:11.5px;color:#9CA3AF;margin-bottom:.75rem;line-height:1.5;">
        Link a directory contact and place this user now. ${superA ? 'Grants below are applied immediately.' : 'Grants are assigned by a super-admin.'}
      </div>
      <div style="${sectionLabel}">Directory Contact</div>
      <div id="inv-contact-picker"></div>
      ${parishBlock}
      ${grantBlock}
    </div>

    <div class="modal-actions" style="align-items:center;">
      <div id="inv-status" style="font-size:12px;color:#6B7280;min-height:16px;margin-right:auto;"></div>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="inv-send">Send Invite</button>
    </div>
  `;

  overlay.classList.add('open');

  // Mount the (drop-in) directory contact picker.
  createContactPicker({
    container: document.getElementById('inv-contact-picker'),
    placeholder: 'Search directory… (optional)',
    onSelect: (person) => { _selectedPerson = person?.id ? person : null; },
  });

  document.getElementById('inv-send').addEventListener('click', () => _sendInvite({ superA, curParishId }));
}

async function _sendInvite({ superA, curParishId }) {
  const emailEl  = document.getElementById('inv-email');
  const sendBtn  = document.getElementById('inv-send');
  const statusEl = document.getElementById('inv-status');
  const email    = emailEl.value.trim();
  if (!email) { statusEl.style.color = '#8B1A2F'; statusEl.textContent = 'Email is required.'; return; }

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  statusEl.style.color = '#6B7280';
  statusEl.textContent = '';

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10000);

  try {
    // 1. Create the account (auth.users row exists immediately; returns userId).
    const res  = await fetch('/invite-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (!res.ok) {
      statusEl.style.color = '#8B1A2F';
      statusEl.textContent = data.error || 'Invite failed.';
      sendBtn.disabled = false; sendBtn.textContent = 'Send Invite';
      return;
    }

    const userId = data.userId;
    // The parish chosen in the placement dropdown, else the current/only parish.
    const parishSel = document.getElementById('inv-parish-select');
    const chosenParishId = (parishSel?.value) || curParishId || null;

    // 2. Optional link + placement (mirrors the keystone upsert in admin.js).
    //    parish_id omitted (undefined) → DB DEFAULT current_parish_id() preserves
    //    the single-parish fail-safe.
    if (userId && _selectedPerson?.id) {
      const { error } = await sb.from('user_profiles').upsert(
        { user_id: userId, personnel_id: _selectedPerson.id, parish_id: chosenParishId || undefined },
        { onConflict: 'user_id' }
      );
      if (error) console.error('[invite] profile link upsert failed:', error);
    }

    // 3. Grants — SUPER-ADMIN ONLY, insert-only (no existing rows to diff/strip).
    //    Prep keys stamp the chosen parish; cura/other → NULL (same split as
    //    admin.js:600-616).
    if (superA && userId) {
      const desiredSac = Array.from(document.querySelectorAll('.inv-sac-cb'))
        .filter(c => c.checked).map(c => c.dataset.sacrament);
      if (desiredSac.length) {
        const { error } = await sb.from('sacramental_roles').insert(desiredSac.map(s => ({
          user_id: userId, sacrament: s,
          parish_id: PREP_PROGRAMS.has(s) ? (chosenParishId || null) : null,
        })));
        if (error) console.error('[invite] sacramental_roles insert failed:', error);
      }
      const desiredGrants = Array.from(document.querySelectorAll('.inv-grant-cb'))
        .filter(c => c.checked).map(c => c.dataset.panel);
      if (desiredGrants.length) {
        const { error } = await sb.from('panel_grants').insert(desiredGrants.map(p => ({
          user_id: userId, panel: p,
          parish_id: PREP_PROGRAMS.has(p) ? (chosenParishId || null) : null,
        })));
        if (error) console.error('[invite] panel_grants insert failed:', error);
      }
    }

    statusEl.style.color = '#2E7D32';
    statusEl.textContent = `Invite sent to ${email}`;
    emailEl.value = '';
  } catch (err) {
    clearTimeout(timeout);
    statusEl.style.color = '#8B1A2F';
    statusEl.textContent = err.name === 'AbortError'
      ? 'Request timed out — please try again.'
      : 'Network error — please try again.';
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send Invite';
  }
}
