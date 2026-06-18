import { sb } from '../supabase.js';
import { store } from '../store.js';

const PALETTE = ['#1C2B3A', '#8B1A2F', '#C9A84C', '#2E7D32', '#1565C0', '#6A1B9A'];

function _colorForId(id) {
  if (!id) return PALETTE[0];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function _initials(name) {
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function _buildEl(size, avatarUrl, name, userId) {
  const el = document.createElement('div');
  el.style.cssText = `
    width:${size}px;height:${size}px;border-radius:50%;
    overflow:hidden;flex-shrink:0;display:inline-flex;
    align-items:center;justify-content:center;
  `;

  if (avatarUrl) {
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = name || '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    img.onerror = () => _applyInitials(el, size, name, userId);
    el.appendChild(img);
  } else {
    _applyInitials(el, size, name, userId);
  }
  return el;
}

function _applyInitials(el, size, name, userId) {
  const initials = _initials(name);
  const bg = _colorForId(userId);
  el.style.background = bg;
  el.innerHTML = initials
    ? `<span style="color:#fff;font-size:${Math.round(size * 0.38)}px;font-weight:600;font-family:'Inter',sans-serif;line-height:1;">${initials}</span>`
    : `<span style="color:rgba(255,255,255,.7);font-size:${Math.round(size * 0.5)}px;line-height:1;">👤</span>`;
}

export function createAvatar({ container, userId, name, avatarUrl = null, size = 32 }) {
  container.innerHTML = '';

  // Check store first
  const profile = userId && store.currentUserProfile?.user_id === userId
    ? store.currentUserProfile
    : null;

  // Prefer a pre-fetched avatarUrl (avoids an N+1 query), then the store hit.
  const effectiveUrl = avatarUrl || profile?.avatar_url || null;
  const el = _buildEl(size, effectiveUrl, name, userId);
  container.appendChild(el);

  // Only hit the DB when we have neither a provided URL nor a store hit.
  if (!effectiveUrl && !profile && userId) {
    sb.from('user_profiles').select('avatar_url,initials_color').eq('user_id', userId).maybeSingle()
      .then(({ data }) => {
        if (data?.avatar_url) {
          el.innerHTML = '';
          const img = document.createElement('img');
          img.src = data.avatar_url;
          img.alt = name || '';
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
          img.onerror = () => _applyInitials(el, size, name, userId);
          el.style.background = '';
          el.appendChild(img);
        }
      });
  }

  return {
    element: el,
    update({ avatarUrl, name: newName } = {}) {
      el.innerHTML = '';
      el.style.background = '';
      if (avatarUrl) {
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = newName || name || '';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        img.onerror = () => _applyInitials(el, size, newName || name, userId);
        el.appendChild(img);
      } else {
        _applyInitials(el, size, newName || name, userId);
      }
    },
  };
}
