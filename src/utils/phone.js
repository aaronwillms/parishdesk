// ── Shared phone-number formatting ──────────────────────────────────────────
// One helper for the whole app. Phones are STORED as normalized digits and
// formatted on input (live mask) and on display. The formatter re-derives from
// digits, so existing stored values (formatted or not) render correctly with no
// data migration required.
//
//   formatPhone(value)        → "(XXX)-XXX-XXXX" for a US 10-digit number,
//                               else the input UNCHANGED (degrade gracefully).
//   normalizePhone(value)     → digits only, leading US "1" dropped (use on save).
//   attachPhoneMask(inputEl)  → live mask as the user types (caret-stable).
//   installPhoneMask(root)    → auto-attach the mask to every input[type=tel]
//                               now and as forms are injected later.

// Digits only, with a leading US country-code "1" stripped from 11-digit input.
function digitsOf(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d;
}

export function normalizePhone(value) {
  if (value == null) return value;
  return digitsOf(value);
}

// Display formatter: only touches a clean 10-digit US number. Anything else
// (partials, extensions, intl, free text) is returned unchanged so we never
// mangle non-standard values.
export function formatPhone(value) {
  if (value == null) return '';
  const str = String(value);
  const d = digitsOf(str);
  if (d.length === 10) return `(${d.slice(0, 3)})-${d.slice(3, 6)}-${d.slice(6)}`;
  return str;
}

// Progressive formatter for the live mask: formats as the area code / prefix
// fill in, without forcing a closing paren before the area code exists. Leaves
// anything longer than a 10-digit US number untouched (extensions, intl).
function formatProgressive(value) {
  const raw = String(value ?? '');
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length > 10) return raw;                 // non-standard: don't mangle
  if (d.length === 0) return '';
  if (d.length < 4)  return `(${d}`;             // (60 / (601
  if (d.length < 7)  return `(${d.slice(0, 3)})-${d.slice(3)}`;
  return `(${d.slice(0, 3)})-${d.slice(3, 6)}-${d.slice(6)}`;
}

// Count digits in the slice before a caret offset — the anchor we use to keep
// the caret stable across reformatting.
function countDigits(str, end) {
  let n = 0;
  for (let i = 0; i < end && i < str.length; i++) if (str[i] >= '0' && str[i] <= '9') n++;
  return n;
}

// Place the caret just after the Nth digit in the formatted string.
function caretAfterNthDigit(str, n) {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] >= '0' && str[i] <= '9') {
      seen++;
      if (seen === n) return i + 1;
    }
  }
  return str.length;
}

function reformat(el) {
  const before = el.value;
  const caret = el.selectionStart ?? before.length;
  const digitsBefore = countDigits(before, caret);
  const formatted = formatProgressive(before);
  if (formatted !== before) el.value = formatted;
  const pos = caretAfterNthDigit(el.value, digitsBefore);
  try { el.setSelectionRange(pos, pos); } catch { /* unsupported input type */ }
}

export function attachPhoneMask(el) {
  if (!el || el.dataset.phoneMasked === '1') return;
  el.dataset.phoneMasked = '1';
  el.setAttribute('type', 'tel');
  el.setAttribute('inputmode', 'tel');

  // Format whatever value the field opened with (stored digits → pretty).
  if (el.value) el.value = formatProgressive(el.value);

  // Backspace over a separator should delete the adjacent DIGIT, not just the
  // separator (otherwise the reformat re-adds it and the user gets stuck).
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace') return;
    if (el.selectionStart !== el.selectionEnd) return;     // let range-delete run
    const pos = el.selectionStart;
    if (pos > 0 && !(el.value[pos - 1] >= '0' && el.value[pos - 1] <= '9')) {
      e.preventDefault();
      let i = pos - 1;
      while (i >= 0 && !(el.value[i] >= '0' && el.value[i] <= '9')) i--;  // skip separators
      const next = i >= 0 ? el.value.slice(0, i) + el.value.slice(pos) : el.value.slice(pos);
      el.value = next;
      const anchor = Math.max(i, 0);
      try { el.setSelectionRange(anchor, anchor); } catch { /* ignore */ }
      reformat(el);
    }
  });

  // Covers typing AND paste (paste fires an 'input' event too).
  el.addEventListener('input', () => reformat(el));
}

// Attach the mask to every phone input now in `root`, and to any injected later
// (the app builds forms as HTML strings and injects them into modal containers).
export function installPhoneMask(root = document.body) {
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches?.('input[type="tel"]')) attachPhoneMask(node);
    node.querySelectorAll?.('input[type="tel"]').forEach(attachPhoneMask);
  };
  scan(root);
  new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(scan);
  }).observe(root, { childList: true, subtree: true });
}
