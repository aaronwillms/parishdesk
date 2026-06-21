// ── Shared editable-note mechanism (notes_log jsonb + annulment text-JSON + the
// discernment_notes table) ──────────────────────────────────────────────────
// Notes are add/delete only across the app; this adds EDIT. The shared bits are
// the edit UX (a prompt pre-filled with the current text) and the "edited"
// marker; each panel keeps its own storage write (it already owns add/delete).
// On edit a panel overwrites the note text and stamps `edited_at` (ISO) — NO
// prior versions are kept. The marker renders via the app's shared formatDateMDY.

import { formatDateMDY } from '../utils.js';

// "edited MM/DD/YYYY" marker for a note carrying an edited_at timestamp (or '').
export function noteEditedMarker(editedAt) {
  if (!editedAt) return '';
  return `<span class="note-edited" style="font-size:10.5px;color:#9CA3AF;font-style:italic;margin-left:6px;">edited ${formatDateMDY(String(editedAt).slice(0, 10))}</span>`;
}

// Prompt the user to edit a note's text (pre-filled with the current text).
// Returns the trimmed new text, or null when the caller should NO-OP — i.e. the
// user cancelled, left it unchanged, or emptied it.
export function promptNoteEdit(currentText) {
  const cur = currentText == null ? '' : String(currentText);
  const next = window.prompt('Edit note:', cur);
  if (next === null) return null;          // cancelled
  const t = next.trim();
  if (!t || t === cur) return null;        // unchanged / emptied → no write
  return t;
}

// Shared edit for the notes_log jsonb shape ({ note, by, created_at }) used by
// First Communion, Confirmation, Baptism and Marriage. Deep-clones the log,
// prompts for new text, and overwrites the entry's `note` + stamps `edited_at`.
// Returns the new log array to persist, or null for a no-op (cancel/unchanged).
export function editNoteLog(log, idx, nowIso) {
  const arr = Array.isArray(log) ? JSON.parse(JSON.stringify(log)) : [];
  if (idx < 0 || idx >= arr.length) return null;
  const text = promptNoteEdit(arr[idx].note);
  if (text === null) return null;
  arr[idx] = { ...arr[idx], note: text, edited_at: nowIso() };
  return arr;
}
