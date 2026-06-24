// ── Seal-of-confession keyword guard (shared, reusable across note paths) ─────
// A pause-and-reconsider prompt fired BEFORE a free-text note is persisted, when it
// contains words that may document that someone received the Sacrament of Penance —
// which would breach the seal of confession and create a permanent parish record.
//
// HONEST SCOPE: this is a WARNING, never a hard block. It catches the careless /
// thoughtless case (literal trigger words), NOT paraphrase or intent. The legitimate
// case ("he asked about going to confession") must be able to pass via "Save anyway".
// Never silently strips or refuses text. Reuse: any add/save-note path can call
// `await sealGuardConfirm(text)` and only persist if it resolves true.

// Whole-word, case-insensitive (word-boundary — NOT substring, so "confessional
// architecture" matches but "self-conscious" does not).
const SEAL_WORDS = ['confession', 'confess', 'confessed', 'penance', 'reconciliation', 'absolution', 'absolved'];
const SEAL_RE = new RegExp(`\\b(?:${SEAL_WORDS.join('|')})\\b`, 'i');

export function checkSealKeywords(text) {
  return SEAL_RE.test(String(text == null ? '' : text));
}

const WARN_TEXT = 'This note may record that someone received the Sacrament of Penance. '
  + 'Logging that a confession occurred breaches the seal of confession and creates a '
  + 'permanent parish record of it. Please remove any such reference.';

// Returns Promise<boolean>: true → proceed (no trigger words, or the user chose
// "Save anyway"); false → the user chose "Edit note" (return to the field, don't save).
export function sealGuardConfirm(text) {
  if (!checkSealKeywords(text)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(20,25,35,.55);display:flex;align-items:center;justify-content:center;padding:1rem;';
    const btn = (extra) => `border-radius:8px;padding:.5rem 1rem;font-size:13px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;border:none;${extra}`;
    ov.innerHTML = `<div role="alertdialog" aria-label="Possible seal-of-confession reference" style="background:#fff;border-radius:10px;max-width:440px;width:100%;padding:1.25rem 1.35rem;box-shadow:0 12px 40px rgba(0,0,0,.3);">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:.6rem;">
        <i class="fa-solid fa-triangle-exclamation" style="color:#B9892F;font-size:18px;"></i>
        <span style="font-weight:700;font-size:15px;color:#1C2B3A;font-family:'Inter',sans-serif;">Possible seal-of-confession reference</span>
      </div>
      <div style="font-size:13px;color:#374151;line-height:1.55;margin-bottom:1.1rem;font-family:'Inter',sans-serif;">${WARN_TEXT}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button data-seal="save" style="${btn('background:#F0EDE8;color:#6B7280;')}">Save anyway</button>
        <button data-seal="edit" style="${btn('background:#8B1A2F;color:#fff;')}">Edit note</button>
      </div>
    </div>`;
    const done = (val) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    ov.addEventListener('click', (e) => {
      if (e.target === ov) return done(false);   // backdrop → safe default (Edit)
      const b = e.target.closest('[data-seal]');
      if (b) done(b.dataset.seal === 'save');
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    ov.querySelector('[data-seal="edit"]').focus();   // "Edit note" is the default
  });
}
