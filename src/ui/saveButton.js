// ── Shared "Saved ✓" save-button confirmation ──────────────────────────────
// ONE behavior used app-wide: on a SUCCESSFUL save the triggering button turns green,
// shows a check + "Saved", then reverts to its original label/style after ~2s.
//
// Fires on SUCCESS ONLY — callers invoke flashSaved()/flashSavedThen() from the
// post-write success branch (after the supabase write / withWriteRetry returns with no
// error). On failure the caller runs its existing error handling and never calls these,
// so a real failure is never shown as a success.
//
// The button is resolved automatically from the most-recently-clicked button (captured
// in the capture phase, before the button's own onclick handler runs), so wiring a save
// flow is a one-line success-branch addition — no markup/onclick changes needed. An
// explicit element may also be passed (e.g. the shell's #sac-save button).

let _lastClickedBtn = null;
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button');
    if (btn) _lastClickedBtn = btn;
  }, true);   // capture phase → recorded before the onclick save handler executes
}

function _restore(btn) {
  const o = btn._saveOrig; if (!o) return;
  btn.innerHTML = o.html; btn.className = o.className; btn.disabled = o.disabled; btn.style.width = o.width || '';
  btn._saveOrig = null; btn._saveFlashTimer = null;
}

// Flash a button green with a check + label, reverting after `ms`. Defaults to the
// most-recently-clicked button. No-op if the button is gone (e.g. keyboard-triggered).
export function flashSaved(btn = _lastClickedBtn, { label = 'Saved', ms = 2000 } = {}) {
  if (!btn || !btn.isConnected) return;
  if (btn._saveFlashTimer) clearTimeout(btn._saveFlashTimer);
  if (!btn._saveOrig) btn._saveOrig = { html: btn.innerHTML, className: btn.className, disabled: btn.disabled, width: btn.style.width };
  btn.style.width = btn.offsetWidth + 'px';   // pin width so the label swap doesn't jump
  btn.disabled = false;
  btn.classList.add('btn-saved');
  btn.innerHTML = `<i class="fa-solid fa-check" style="margin-right:5px;"></i>${label}`;
  btn._saveFlashTimer = setTimeout(() => _restore(btn), ms);
}

// Flash the (just-clicked) save button, THEN run `after` once the confirmation has been
// visible briefly. For flows that would otherwise destroy the button immediately on
// success (close a modal, re-render a card/list).
export function flashSavedThen(after, { delay = 1100, ...opts } = {}) {
  flashSaved(_lastClickedBtn, opts);
  setTimeout(() => { try { after && after(); } catch (e) { console.error(e); } }, delay);
}

if (typeof window !== 'undefined') {
  window.flashSaved = flashSaved;
  window.flashSavedThen = flashSavedThen;
}
