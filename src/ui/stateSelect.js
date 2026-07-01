// ── Shared US state <select> ────────────────────────────────────────────────
// One source of truth for the 50 states + DC (2-letter codes). Replaces the
// per-panel copies that had drifted into 4 places. Stores CODES (option value ==
// the code, matching all existing data). The `label` param preserves panels that
// legitimately differ (Confirmation uses "State/Province"); labelStyle/selectStyle
// let inline-styled forms (Sick & Homebound) match their own field styling while
// the CSS-styled sacramental modals pass nothing.

export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
  'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'];

// Labeled <select id="${id}"> with an empty placeholder option then one option per
// state (value = the code). Preselects the option === val. Byte-compatible with the
// old per-panel _stateSelect output when called with defaults. Pass label:null (or
// false) to render the <select> alone — for callers that supply their own external
// <label> (e.g. Discernment's "State" / "School state").
export function stateSelect(id, val, { label = 'State', placeholder = '—', labelStyle = '', selectStyle = '' } = {}) {
  const ls = labelStyle ? ` style="${labelStyle}"` : '';
  const ss = selectStyle ? ` style="${selectStyle}"` : '';
  const labelHtml = (label === null || label === false) ? '' : `<label${ls}>${label}</label>`;
  const opts = US_STATES.map(s => `<option${s === val ? ' selected' : ''}>${s}</option>`).join('');
  return `${labelHtml}<select id="${id}"${ss}><option value="">${placeholder}</option>${opts}</select>`;
}
