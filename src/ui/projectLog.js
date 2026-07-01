import { sb } from '../supabase.js';
import { store } from '../store.js';
import { logActivity } from '../utils.js';
import { createAvatar } from './avatar.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function _relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts);
  const min  = Math.floor(diff / 60000);
  if (min < 1)  return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(diff / 3600000);
  if (hr < 24)  return `${hr}h ago`;
  const day = Math.floor(diff / 86400000);
  if (day < 7)  return `${day}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function _fillProfiles(ids, profileMap) {
  const unknown = ids.filter(id => id && !profileMap[id]);
  if (!unknown.length) return;
  const { data: profs } = await sb.from('user_profiles')
    .select('user_id, personnel_id, personnel(name)')
    .in('user_id', unknown);
  (profs || []).forEach(p => { profileMap[p.user_id] = { name: p.personnel?.name || 'User', personnelId: p.personnel_id }; });
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function renderProjectLog({ container, projectId, projectTitle, currentUserId, canManage = false }) {
  if (!container) return;
  container.innerHTML = `<div style="padding:2rem;text-align:center;color:#9CA3AF;">Loading…</div>`;

  const roles = store.currentUserRoles || {};
  // Posting/editing log entries is an owner/admin (container-manage) capability. 2b-3 converges the
  // log's privilege onto the caller's canManage (project owner/admin) in addition to app admins.
  const isPrivileged = roles.isAdmin || roles.isSuperAdmin || !!canManage;

  const { data: entries } = await sb.from('project_log')
    .select('id, title, body, created_by, created_at, updated_at, deleted_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  const allEntries = entries || [];
  const profileMap = {};
  await _fillProfiles([...new Set(allEntries.map(e => e.created_by).filter(Boolean))], profileMap);

  let list        = allEntries.filter(e => !e.deleted_at);
  let deletedList = allEntries.filter(e =>  e.deleted_at);
  let _showDeleted = false;
  let _activeId    = null;
  let _commentSub  = null;

  const isMobile = () => window.innerWidth < 640;

  // ── Render shell ──────────────────────────────────────────────────────────

  function rerender() {
    if (isMobile() && _activeId) { _renderMobileDetail(); }
    else if (isMobile())          { _renderMobileList(); }
    else                           { _renderDesktop(); }
  }

  function _renderDesktop() {
    container.innerHTML = `
      <div style="display:flex;height:100%;min-height:480px;border:.5px solid #E2DDD6;border-radius:10px;overflow:hidden;background:#fff;">
        <div style="width:280px;min-width:220px;max-width:280px;border-right:.5px solid #E2DDD6;display:flex;flex-direction:column;background:#FAFAF8;">
          ${isPrivileged ? `<div style="padding:.75rem 1rem;border-bottom:.5px solid #E2DDD6;flex-shrink:0;">
            <button id="pl-new-btn" style="
              width:100%;padding:.45rem .9rem;background:#C9A84C;color:#fff;border:none;
              border-radius:6px;font-size:13px;font-family:'Inter',sans-serif;
              cursor:pointer;font-weight:500;display:flex;align-items:center;justify-content:center;gap:6px;
            "><i class="fa-solid fa-pen" style="font-size:11px;"></i> New Log Entry</button>
          </div>` : ''}
          <div id="pl-list" style="overflow-y:auto;flex:1;">${_listHtml()}</div>
        </div>
        <div id="pl-detail-pane" style="flex:1;display:flex;flex-direction:column;min-width:0;overflow-y:auto;">
          ${_activeId ? '' : _emptyPane()}
        </div>
      </div>`;
    _bindListEvents();
    if (_activeId) _renderDetail(_activeId);
  }

  function _renderMobileList() {
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;min-height:400px;border:.5px solid #E2DDD6;border-radius:10px;overflow:hidden;background:#FAFAF8;">
        ${isPrivileged ? `<div style="padding:.75rem 1rem;border-bottom:.5px solid #E2DDD6;flex-shrink:0;">
          <button id="pl-new-btn" style="
            width:100%;padding:.45rem .9rem;background:#C9A84C;color:#fff;border:none;
            border-radius:6px;font-size:13px;font-family:'Inter',sans-serif;
            cursor:pointer;font-weight:500;display:flex;align-items:center;justify-content:center;gap:6px;
          "><i class="fa-solid fa-pen" style="font-size:11px;"></i> New Log Entry</button>
        </div>` : ''}
        <div id="pl-list" style="overflow-y:auto;flex:1;">${_listHtml()}</div>
      </div>`;
    _bindListEvents();
  }

  function _renderMobileDetail() {
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;min-height:400px;border:.5px solid #E2DDD6;border-radius:10px;overflow:hidden;background:#fff;">
        <div id="pl-detail-pane" style="flex:1;display:flex;flex-direction:column;min-width:0;overflow-y:auto;"></div>
      </div>`;
    if (_activeId) _renderDetail(_activeId, true);
  }

  // ── List HTML ─────────────────────────────────────────────────────────────

  function _listHtml() {
    const activeHtml = list.length
      ? list.map(e => _entryRowHtml(e)).join('')
      : `<div style="padding:2rem 1rem;text-align:center;font-size:13px;color:#9CA3AF;font-style:italic;">No log entries yet.</div>`;

    if (!deletedList.length) return activeHtml;

    const deletedHtml = _showDeleted
      ? deletedList.map(e => _deletedRowHtml(e)).join('')
      : '';

    return activeHtml + `
      <div style="border-top:.5px solid #E2DDD6;margin-top:.5rem;">
        <button id="pl-deleted-toggle" style="
          width:100%;padding:.55rem 1rem;background:none;border:none;cursor:pointer;
          font-size:12px;color:#9CA3AF;font-family:'Inter',sans-serif;
          display:flex;align-items:center;justify-content:space-between;
        ">
          <span>Deleted entries (${deletedList.length})</span>
          <i class="fa-solid fa-chevron-${_showDeleted ? 'up' : 'down'}" style="font-size:10px;"></i>
        </button>
        <div id="pl-deleted-list">${deletedHtml}</div>
      </div>`;
  }

  function _entryRowHtml(e) {
    const profile = profileMap[e.created_by] || {};
    const isActive = e.id === _activeId;
    return `
      <div class="pl-entry-row" data-id="${e.id}" style="
        position:relative;padding:.75rem 1rem;border-bottom:.5px solid #F0EDE8;
        cursor:pointer;transition:background .1s;
        background:${isActive ? 'var(--parch, #F5F1EB)' : 'transparent'};
      " onmouseenter="this.querySelector('.pl-del-btn')&&(this.querySelector('.pl-del-btn').style.opacity='1')"
         onmouseleave="this.querySelector('.pl-del-btn')&&(this.querySelector('.pl-del-btn').style.opacity='0')">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:4px;">
          <div style="font-size:13.5px;font-weight:600;color:#1C2B3A;line-height:1.3;flex:1;min-width:0;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.title}</div>
          <button class="pl-del-btn" data-del-id="${e.id}" style="
            opacity:0;transition:opacity .12s;background:none;border:none;cursor:pointer;
            color:#CCC;font-size:12px;padding:0 0 0 4px;flex-shrink:0;line-height:1;
          " onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'"
            title="Delete entry">✕</button>
        </div>
        <div style="font-size:11.5px;color:#9CA3AF;margin-top:3px;">
          ${profile.name || 'User'} · ${_relTime(e.created_at)}
        </div>
      </div>`;
  }

  function _deletedRowHtml(e) {
    return `
      <div style="padding:.6rem 1rem;border-bottom:.5px solid #F0EDE8;display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="font-size:12.5px;color:#9CA3AF;text-decoration:line-through;flex:1;min-width:0;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.title}</div>
        <button class="pl-restore-btn" data-restore-id="${e.id}" style="
          font-size:11px;color:#C9A84C;background:none;border:.5px solid #C9A84C;
          border-radius:4px;padding:2px 7px;cursor:pointer;flex-shrink:0;font-family:'Inter',sans-serif;
        ">Restore</button>
      </div>`;
  }

  function _emptyPane() {
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#9CA3AF;flex-direction:column;gap:.5rem;">
      <i class="fa-solid fa-book-open" style="font-size:28px;opacity:.3;"></i>
      <div style="font-size:13px;">Select a log entry</div>
    </div>`;
  }

  // ── List event binding ─────────────────────────────────────────────────────

  function _bindListEvents() {
    document.getElementById('pl-new-btn')?.addEventListener('click', _openNewEntryModal);

    document.querySelectorAll('.pl-entry-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.pl-del-btn')) return;
        _activeId = row.dataset.id;
        if (isMobile()) { _renderMobileDetail(); return; }
        document.querySelectorAll('.pl-entry-row').forEach(r => r.style.background = 'transparent');
        row.style.background = 'var(--parch, #F5F1EB)';
        _renderDetail(_activeId);
      });
    });

    document.querySelectorAll('.pl-del-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = btn.dataset.delId;
        const entry = list.find(x => x.id === id);
        if (!confirm(`Delete "${entry?.title || 'this entry'}"?`)) return;
        const { error } = await sb.from('project_log')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', id);
        if (error) { alert('Delete failed: ' + error.message); return; }
        const idx = list.findIndex(x => x.id === id);
        if (idx !== -1) {
          deletedList.unshift({ ...list[idx], deleted_at: new Date().toISOString() });
          list.splice(idx, 1);
        }
        if (_activeId === id) _activeId = null;
        rerender();
      });
    });

    document.getElementById('pl-deleted-toggle')?.addEventListener('click', () => {
      _showDeleted = !_showDeleted;
      const listEl = document.getElementById('pl-list');
      if (listEl) listEl.innerHTML = _listHtml();
      _bindListEvents();
    });

    document.querySelectorAll('.pl-restore-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.restoreId;
        const { error } = await sb.from('project_log')
          .update({ deleted_at: null })
          .eq('id', id);
        if (error) { alert('Restore failed: ' + error.message); return; }
        const idx = deletedList.findIndex(x => x.id === id);
        if (idx !== -1) {
          list.unshift({ ...deletedList[idx], deleted_at: null });
          deletedList.splice(idx, 1);
        }
        rerender();
      });
    });
  }

  // ── Detail pane ───────────────────────────────────────────────────────────

  async function _renderDetail(entryId, showBack = false) {
    const pane = document.getElementById('pl-detail-pane');
    if (!pane) return;
    pane.innerHTML = `<div style="padding:2rem;text-align:center;color:#9CA3AF;">Loading…</div>`;

    if (_commentSub) { _commentSub.unsubscribe(); _commentSub = null; }

    const entry = list.find(x => x.id === entryId);
    if (!entry) { pane.innerHTML = _emptyPane(); return; }

    await _fillProfiles([entry.created_by].filter(Boolean), profileMap);

    const { data: commentsRaw } = await sb.from('project_log_comments')
      .select('id, body, created_by, created_at, updated_at, deleted_at')
      .eq('log_entry_id', entryId)
      .order('created_at');
    let comments = commentsRaw || [];

    await _fillProfiles([...new Set(comments.map(c => c.created_by).filter(Boolean))], profileMap);

    const authorProfile = profileMap[entry.created_by] || {};
    const canEdit = isPrivileged
      || entry.created_by === currentUserId
      || _project?.created_by === currentUserId;

    function _commentHtml(c) {
      if (c.deleted_at) return `
        <div style="padding:.5rem 0;font-size:12.5px;color:#9CA3AF;font-style:italic;">Comment deleted</div>`;
      const cp = profileMap[c.created_by] || {};
      const canEditC = isPrivileged || c.created_by === currentUserId;
      return `
        <div class="pl-comment-row" data-comment-id="${c.id}"
          style="display:flex;gap:8px;padding:.6rem .75rem;border-radius:6px;background:#F8F7F4;margin-bottom:6px;"
          onmouseenter="this.querySelector('.pl-comment-actions')&&(this.querySelector('.pl-comment-actions').style.opacity='1')"
          onmouseleave="this.querySelector('.pl-comment-actions')&&(this.querySelector('.pl-comment-actions').style.opacity='0')">
          <div class="pl-comment-av" data-uid="${c.created_by || ''}" data-name="${cp.name || 'User'}"></div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;">
              <span style="font-size:12px;font-weight:600;color:#1C2B3A;">${cp.name || 'User'}</span>
              <span style="font-size:11px;color:#9CA3AF;">${_relTime(c.created_at)}</span>
              ${canEditC ? `<span class="pl-comment-actions" style="display:flex;align-items:center;gap:4px;opacity:0;transition:opacity .12s;margin-left:auto;">
                <button class="pl-comment-edit-btn" data-comment-id="${c.id}" style="background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:11px;padding:1px 4px;" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                <button class="pl-comment-del-btn" data-comment-id="${c.id}" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:12px;padding:1px 4px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'" title="Delete">✕</button>
              </span>` : ''}
            </div>
            <div class="pl-comment-body" style="font-size:13px;color:#374151;line-height:1.5;white-space:pre-wrap;">${_esc(c.body)}</div>
          </div>
        </div>`;
    }

    function _renderPane() {
      const activeComments = comments.filter(c => !c.deleted_at);
      const deletedComments = comments.filter(c => c.deleted_at);
      const allSorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));

      pane.innerHTML = `
        ${showBack ? `
          <div style="padding:.6rem 1rem;border-bottom:.5px solid #E2DDD6;flex-shrink:0;">
            <button id="pl-back" style="background:none;border:none;cursor:pointer;color:#8FA8BF;font-size:14px;font-family:'Inter',sans-serif;">
              ← Back
            </button>
          </div>` : ''}
        <div style="padding:1.25rem 1.5rem;flex:1;">
          <!-- Entry header -->
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:1rem;">
            <h2 id="pl-entry-title" style="
              font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:700;
              color:#1C2B3A;margin:0;line-height:1.3;flex:1;
            ">${_esc(entry.title)}</h2>
            ${canEdit ? `<button id="pl-edit-btn" style="
              background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:13px;
              padding:4px 6px;flex-shrink:0;transition:color .12s;display:flex;align-items:center;gap:5px;
            " onmouseover="this.style.color='#1C2B3A'" onmouseout="this.style.color='#9CA3AF'" title="Edit entry">
              <i class="fa-solid fa-pencil"></i>
            </button>` : ''}
          </div>
          <!-- Author line -->
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:1.25rem;">
            <div id="pl-author-av"></div>
            <div>
              <div style="font-size:13px;font-weight:500;color:#1C2B3A;">${authorProfile.name || 'User'}</div>
              <div style="font-size:11.5px;color:#9CA3AF;">${_relTime(entry.created_at)}</div>
            </div>
          </div>
          <!-- Body -->
          <div id="pl-body-area" style="font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap;margin-bottom:1.5rem;">${_esc(entry.body)}</div>
          <!-- Comments divider -->
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:1rem;">
            <hr style="flex:1;border:none;border-top:.5px solid #E2DDD6;" />
            <span style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;">
              Comments${activeComments.length ? ` (${activeComments.length})` : ''}
            </span>
            <hr style="flex:1;border:none;border-top:.5px solid #E2DDD6;" />
          </div>
          <!-- Comments list -->
          <div id="pl-comments-list">
            ${allSorted.map(c => _commentHtml(c)).join('')}
            ${!comments.length ? `<div style="font-size:13px;color:#9CA3AF;font-style:italic;margin-bottom:1rem;">No comments yet.</div>` : ''}
          </div>
          <!-- Add comment -->
          <div style="margin-top:1rem;border-top:.5px solid #F0EDE8;padding-top:1rem;">
            <textarea id="pl-comment-input" rows="2" placeholder="Add a comment…" style="
              width:100%;box-sizing:border-box;padding:.5rem .7rem;
              border:.5px solid #D1C9BE;border-radius:6px;font-size:13px;
              font-family:'Inter',sans-serif;outline:none;resize:vertical;background:#fff;
            "></textarea>
            <div style="display:flex;justify-content:flex-end;margin-top:6px;">
              <button id="pl-comment-submit" style="
                padding:.4rem 1rem;background:#8B1A2F;color:#fff;border:none;
                border-radius:6px;font-size:13px;font-family:'Inter',sans-serif;
                cursor:pointer;font-weight:500;
              ">Add Comment</button>
            </div>
          </div>
        </div>`;

      // Mount avatars
      const authorAvEl = document.getElementById('pl-author-av');
      if (authorAvEl) createAvatar({ container: authorAvEl, userId: entry.created_by, name: authorProfile.name || 'User', size: 32 });

      document.querySelectorAll('.pl-comment-av').forEach(el => {
        createAvatar({ container: el, userId: el.dataset.uid, name: el.dataset.name, size: 24 });
      });

      // Back button (mobile)
      document.getElementById('pl-back')?.addEventListener('click', () => {
        _activeId = null;
        _renderMobileList();
      });

      // Inline edit entry
      document.getElementById('pl-edit-btn')?.addEventListener('click', () => {
        const bodyArea = document.getElementById('pl-body-area');
        const titleEl  = document.getElementById('pl-entry-title');
        const editBtn  = document.getElementById('pl-edit-btn');
        if (!bodyArea || !titleEl) return;
        const origTitle = entry.title;
        const origBody  = entry.body;
        titleEl.contentEditable = 'true';
        titleEl.style.border = '.5px solid #D1C9BE';
        titleEl.style.borderRadius = '6px';
        titleEl.style.padding = '2px 6px';
        titleEl.focus();
        bodyArea.innerHTML = `
          <textarea id="pl-body-edit" rows="8" style="
            width:100%;box-sizing:border-box;padding:.5rem .7rem;
            border:.5px solid #D1C9BE;border-radius:6px;font-size:14px;
            font-family:'Inter',sans-serif;outline:none;resize:vertical;background:#fff;
          ">${_esc(origBody)}</textarea>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="pl-body-save" style="
              padding:.4rem 1rem;background:#1C2B3A;color:#fff;border:none;
              border-radius:6px;font-size:13px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:500;
            ">Save</button>
            <button id="pl-body-cancel" style="
              padding:.4rem .9rem;background:none;color:#6B7280;
              border:.5px solid #D1C9BE;border-radius:6px;
              font-size:13px;font-family:'Inter',sans-serif;cursor:pointer;
            ">Cancel</button>
          </div>`;
        editBtn.style.display = 'none';
        document.getElementById('pl-body-cancel').addEventListener('click', () => {
          titleEl.contentEditable = 'false';
          titleEl.style.border = '';
          titleEl.style.padding = '';
          titleEl.textContent = origTitle;
          bodyArea.style.whiteSpace = 'pre-wrap';
          bodyArea.textContent = origBody;
          editBtn.style.display = '';
        });
        document.getElementById('pl-body-save').addEventListener('click', async () => {
          const newTitle = titleEl.textContent.trim();
          const newBody  = document.getElementById('pl-body-edit').value.trim();
          if (!newTitle || !newBody) { alert('Title and body are required.'); return; }
          const { error } = await sb.from('project_log')
            .update({ title: newTitle, body: newBody, updated_at: new Date().toISOString() })
            .eq('id', entryId);
          if (error) { alert('Save failed: ' + error.message); return; }
          entry.title = newTitle;
          entry.body  = newBody;
          // Update list item title
          const rowEl = document.querySelector(`.pl-entry-row[data-id="${entryId}"] div`);
          if (rowEl) rowEl.textContent = newTitle;
          _renderPane();
        });
      });

      // Comment submit
      document.getElementById('pl-comment-submit')?.addEventListener('click', async () => {
        const body = document.getElementById('pl-comment-input').value.trim();
        if (!body) return;
        const { data: nc, error } = await sb.from('project_log_comments')
          .insert({ log_entry_id: entryId, body, created_by: currentUserId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .select().single();
        if (error) { alert('Comment failed: ' + error.message); return; }
        await _fillProfiles([nc.created_by].filter(Boolean), profileMap);
        comments.push(nc);
        logActivity({ action: 'commented on project log', entityType: 'project', entityName: projectTitle, contextType: 'project', contextId: projectId });
        document.getElementById('pl-comment-input').value = '';
        document.getElementById('pl-comments-list').innerHTML =
          [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at)).map(c => _commentHtml(c)).join('');
        document.querySelectorAll('.pl-comment-av').forEach(el => {
          createAvatar({ container: el, userId: el.dataset.uid, name: el.dataset.name, size: 24 });
        });
        _bindCommentEvents();
      });

      _bindCommentEvents();

      // Realtime
      if (_commentSub) _commentSub.unsubscribe();
      _commentSub = sb.channel(`pl-comments-${entryId}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'project_log_comments',
          filter: `log_entry_id=eq.${entryId}`,
        }, async payload => {
          const r = payload.new;
          if (comments.find(c => c.id === r.id)) return;
          await _fillProfiles([r.created_by].filter(Boolean), profileMap);
          comments.push(r);
          const listEl = document.getElementById('pl-comments-list');
          if (listEl) {
            listEl.innerHTML = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at)).map(c => _commentHtml(c)).join('');
            document.querySelectorAll('.pl-comment-av').forEach(el => {
              createAvatar({ container: el, userId: el.dataset.uid, name: el.dataset.name, size: 24 });
            });
            _bindCommentEvents();
          }
        })
        .subscribe();
    }

    function _bindCommentEvents() {
      document.querySelectorAll('.pl-comment-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => _editComment(btn.dataset.commentId));
      });
      document.querySelectorAll('.pl-comment-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.commentId;
          const { error } = await sb.from('project_log_comments')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', id);
          if (error) { alert('Delete failed: ' + error.message); return; }
          const c = comments.find(x => x.id === id);
          if (c) c.deleted_at = new Date().toISOString();
          const listEl = document.getElementById('pl-comments-list');
          if (listEl) {
            listEl.innerHTML = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at)).map(c => _commentHtml(c)).join('');
            document.querySelectorAll('.pl-comment-av').forEach(el => {
              createAvatar({ container: el, userId: el.dataset.uid, name: el.dataset.name, size: 24 });
            });
            _bindCommentEvents();
          }
        });
      });
    }

    function _editComment(commentId) {
      const c = comments.find(x => x.id === commentId);
      if (!c) return;
      const row = document.querySelector(`.pl-comment-row[data-comment-id="${commentId}"]`);
      if (!row) return;
      const bodyDiv = row.querySelector('.pl-comment-body');
      if (!bodyDiv) return;
      const orig = c.body;
      bodyDiv.innerHTML = `
        <textarea style="width:100%;box-sizing:border-box;padding:.35rem .5rem;border:.5px solid #D1C9BE;
          border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;outline:none;resize:vertical;
          background:#fff;" rows="3">${_esc(orig)}</textarea>
        <div style="display:flex;gap:6px;margin-top:5px;">
          <button class="pl-cedit-save" style="padding:.3rem .75rem;background:#1C2B3A;color:#fff;border:none;
            border-radius:5px;font-size:12px;font-family:'Inter',sans-serif;cursor:pointer;">Save</button>
          <button class="pl-cedit-cancel" style="padding:.3rem .7rem;background:none;color:#6B7280;
            border:.5px solid #D1C9BE;border-radius:5px;font-size:12px;font-family:'Inter',sans-serif;cursor:pointer;">Cancel</button>
        </div>`;
      row.querySelector('.pl-cedit-cancel').addEventListener('click', () => {
        bodyDiv.style.whiteSpace = 'pre-wrap';
        bodyDiv.className = 'pl-comment-body';
        bodyDiv.style.cssText = 'font-size:13px;color:#374151;line-height:1.5;white-space:pre-wrap;';
        bodyDiv.textContent = orig;
      });
      row.querySelector('.pl-cedit-save').addEventListener('click', async () => {
        const newBody = bodyDiv.querySelector('textarea').value.trim();
        if (!newBody) return;
        const { error } = await sb.from('project_log_comments')
          .update({ body: newBody, updated_at: new Date().toISOString() })
          .eq('id', commentId);
        if (error) { alert('Save failed: ' + error.message); return; }
        c.body = newBody;
        bodyDiv.style.whiteSpace = 'pre-wrap';
        bodyDiv.className = 'pl-comment-body';
        bodyDiv.style.cssText = 'font-size:13px;color:#374151;line-height:1.5;white-space:pre-wrap;';
        bodyDiv.textContent = newBody;
      });
    }

    _renderPane();
  }

  // ── New entry modal ────────────────────────────────────────────────────────

  function _openNewEntryModal() {
    document.getElementById('modal-content').innerHTML = `
      <div class="modal-title">New Log Entry</div>
      <label>Title *</label>
      <input id="pl-new-title" placeholder="Entry title" style="margin-bottom:10px;" />
      <label>Body *</label>
      <textarea id="pl-new-body" rows="7" placeholder="Write your log entry here…" style="
        width:100%;box-sizing:border-box;padding:.45rem .7rem;
        border:.5px solid #D1C9BE;border-radius:6px;font-size:13.5px;
        font-family:'Inter',sans-serif;outline:none;resize:vertical;background:#fff;
      "></textarea>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancel</button>
        <button id="pl-new-save" class="btn-primary">Save</button>
      </div>`;
    document.getElementById('modal-overlay').classList.add('open');
    document.getElementById('pl-new-title').focus();
    document.getElementById('pl-new-save').addEventListener('click', async () => {
      const title = document.getElementById('pl-new-title').value.trim();
      const body  = document.getElementById('pl-new-body').value.trim();
      if (!title) { document.getElementById('pl-new-title').focus(); return; }
      if (!body)  { document.getElementById('pl-new-body').focus(); return; }
      const { data: ne, error } = await sb.from('project_log')
        .insert({ project_id: projectId, title, body, created_by: currentUserId })
        .select().single();
      if (error) { alert('Save failed: ' + error.message); return; }
      await _fillProfiles([ne.created_by].filter(Boolean), profileMap);
      list.unshift(ne);
      _activeId = ne.id;
      logActivity({ action: 'added project log entry', entityType: 'project', entityName: projectTitle, contextType: 'project', contextId: projectId });
      closeModal();
      rerender();
    });
  }

  // ── Kick off ───────────────────────────────────────────────────────────────

  rerender();
}

// ── Escape helper ──────────────────────────────────────────────────────────

function _esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
