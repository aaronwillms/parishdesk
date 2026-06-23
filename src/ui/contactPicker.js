import { sb } from '../supabase.js';
import { store } from '../store.js';
import { personTitle } from '../utils.js';

// ── Styles (injected once) ─────────────────────────────────────────────────

let _styleInjected = false;

function injectStyles() {
  if (_styleInjected) return;
  _styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .cp-wrap {
      position: relative;
      font-family: 'Inter', sans-serif;
    }
    .cp-input {
      width: 100%;
      box-sizing: border-box;
      padding: .4rem .65rem;
      border: .5px solid #D1C9BE;
      border-radius: var(--radius-sm, 5px);
      font-size: 13px;
      font-family: 'Inter', sans-serif;
      background: #fff;
      color: #1C2B3A;
      outline: none;
      transition: border-color .15s;
    }
    .cp-input:focus {
      border-color: #1C2B3A;
    }
    .cp-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      background: #fff;
      border: .5px solid #D1C9BE;
      border-radius: var(--radius-sm, 5px);
      box-shadow: 0 6px 20px rgba(0,0,0,.1);
      z-index: 600;
      max-height: 240px;
      overflow-y: auto;
    }
    .cp-option {
      padding: .55rem .75rem;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 1px;
      border-bottom: .5px solid #F0EDE8;
      transition: background .1s;
    }
    .cp-option:last-child { border-bottom: none; }
    .cp-option:hover, .cp-option.cp-focused { background: #F8F7F4; }
    .cp-option-name { font-size: 13px; color: #1C2B3A; font-weight: 500; }
    .cp-option-sub  { font-size: 11.5px; color: #6B7280; }
    .cp-add-row {
      padding: .55rem .75rem;
      cursor: pointer;
      font-size: 13px;
      color: #8B1A2F;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 6px;
      border-top: .5px solid #F0EDE8;
      transition: background .1s;
    }
    .cp-add-row:hover { background: #FDF5F5; }
    .cp-new-form {
      padding: .65rem .75rem;
      border-top: .5px solid #F0EDE8;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .cp-new-form input {
      width: 100%;
      box-sizing: border-box;
      padding: .35rem .55rem;
      border: .5px solid #D1C9BE;
      border-radius: var(--radius-sm, 5px);
      font-size: 12.5px;
      font-family: 'Inter', sans-serif;
      outline: none;
    }
    .cp-new-form input:focus { border-color: #1C2B3A; }
    .cp-new-form-actions {
      display: flex;
      gap: 6px;
      margin-top: 2px;
    }
    .cp-btn-save {
      padding: .3rem .7rem;
      background: #1C2B3A;
      color: #fff;
      border: none;
      border-radius: var(--radius-sm, 5px);
      font-size: 12px;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      font-weight: 500;
    }
    .cp-btn-save:hover { background: #263d52; }
    .cp-btn-cancel {
      padding: .3rem .7rem;
      background: none;
      color: #6B7280;
      border: .5px solid #D1C9BE;
      border-radius: var(--radius-sm, 5px);
      font-size: 12px;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
    }
    .cp-empty {
      padding: .6rem .75rem;
      font-size: 13px;
      color: #9CA3AF;
      font-style: italic;
    }
    .cp-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #1C2B3A;
      color: #fff;
      border-radius: 20px;
      padding: .3rem .75rem .3rem .8rem;
      font-size: 13px;
      font-family: 'Inter', sans-serif;
      font-weight: 500;
    }
    .cp-chip-clear {
      background: none;
      border: none;
      color: rgba(255,255,255,.65);
      cursor: pointer;
      font-size: 14px;
      padding: 0;
      line-height: 1;
      display: flex;
      align-items: center;
    }
    .cp-chip-clear:hover { color: #fff; }
  `;
  document.head.appendChild(style);
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createContactPicker({ container, placeholder = 'Search by name…', onSelect, initialValue, prefillEmail = '', multiSelect = false }) {
  injectStyles();

  // ── State
  let selectedPerson   = null;  // single-select mode
  let _selectedPersons = [];    // multi-select mode
  let debounceTimer    = null;
  let showingNewForm   = false;
  let _institutions    = []; // fetched once on init

  // Fetch institutions in background so form renders instantly when needed
  sb.from('institutions').select('name').order('name').then(({ data }) => {
    _institutions = (data || []).map(r => r.name).filter(Boolean);
  });

  // ── DOM skeleton
  container.innerHTML = '';
  container.classList.add('cp-wrap');

  // Multi-select chips row (only used when multiSelect=true)
  const chipsRow = document.createElement('div');
  chipsRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:0;';
  if (multiSelect) container.appendChild(chipsRow);

  const input    = document.createElement('input');
  input.type        = 'text';
  input.className   = 'cp-input';
  input.placeholder = placeholder;
  input.autocomplete = 'off';

  const dropdown = document.createElement('div');
  dropdown.className = 'cp-dropdown';
  dropdown.style.display = 'none';

  container.appendChild(input);
  container.appendChild(dropdown);

  // ── Helpers

  function personLabel(p) {
    return p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || '—';
  }

  function personSub(p) {
    return [personTitle(p.id)].filter(Boolean).join(' · ');   // HR-derived title
  }

  function _addChip(person, onRemove) {
    const chip = document.createElement('div');
    chip.className = 'cp-chip';
    chip.innerHTML = `<span>${personLabel(person)}</span>`;
    const clearBtn = document.createElement('button');
    clearBtn.className = 'cp-chip-clear';
    clearBtn.type = 'button';
    clearBtn.innerHTML = '✕';
    clearBtn.addEventListener('click', onRemove);
    chip.appendChild(clearBtn);
    return chip;
  }

  function showChip(person) {
    input.style.display = 'none';
    dropdown.style.display = 'none';
    const chip = _addChip(person, () => {
      chip.remove();
      selectedPerson = null;
      input.value = '';
      input.style.display = '';
      onSelect?.(null);
    });
    container.appendChild(chip);
  }

  function _addMultiChip(person) {
    const chip = _addChip(person, () => {
      chip.remove();
      _selectedPersons = _selectedPersons.filter(p => p.id !== person.id);
      if (!_selectedPersons.length) chipsRow.style.marginBottom = '0';
      onSelect?.([..._selectedPersons]);
    });
    chipsRow.appendChild(chip);
    chipsRow.style.marginBottom = '6px';
  }

  function select(person) {
    if (multiSelect) {
      if (_selectedPersons.find(p => p.id === person.id)) { closeDropdown(); input.value = ''; return; }
      _selectedPersons.push(person);
      _addMultiChip(person);
      closeDropdown();
      input.value = '';
      onSelect?.([..._selectedPersons]);
    } else {
      selectedPerson = person;
      closeDropdown();
      showChip(person);
      onSelect?.(person);
    }
  }

  function openDropdown() { dropdown.style.display = 'block'; }
  function closeDropdown() { dropdown.style.display = 'none'; showingNewForm = false; }

  function renderResults(results, query) {
    dropdown.innerHTML = '';
    showingNewForm = false;

    if (results.length) {
      results.forEach(p => {
        const opt = document.createElement('div');
        opt.className = 'cp-option';
        opt.innerHTML = `<span class="cp-option-name">${personLabel(p)}</span>${personSub(p) ? `<span class="cp-option-sub">${personSub(p)}</span>` : ''}`;
        opt.addEventListener('mousedown', e => { e.preventDefault(); select(p); });
        dropdown.appendChild(opt);
      });
    } else if (query) {
      const empty = document.createElement('div');
      empty.className = 'cp-empty';
      empty.textContent = `No results for "${query}"`;
      dropdown.appendChild(empty);
    }

    // Always show "Add new contact" at bottom
    const addRow = document.createElement('div');
    addRow.className = 'cp-add-row';
    addRow.innerHTML = '<span>＋</span><span>Add new contact</span>';
    addRow.addEventListener('mousedown', e => e.preventDefault());
    addRow.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); showNewForm(query); });
    dropdown.appendChild(addRow);

    openDropdown();
  }

  function showNewForm(prefillName = '') {
    showingNewForm = true;
    dropdown.innerHTML = '';

    const form = document.createElement('div');
    form.className = 'cp-new-form';
    form.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#555;margin-bottom:2px;">New contact</div>
      <input id="cp-new-name"  placeholder="Full name *" value="${prefillName.replace(/"/g, '&quot;')}" />
      <div style="font-size:11px;color:#6B7280;margin-bottom:-2px;">Date of Birth (optional)</div>
      <input type="date" id="cp-new-dob" />
      <div id="cp-new-error" style="font-size:11px;color:#8B1A2F;min-height:14px;margin-top:2px;"></div>
      <div class="cp-new-form-actions">
        <button type="button" class="cp-btn-save"   id="cp-new-save">Add &amp; select</button>
        <button type="button" class="cp-btn-cancel" id="cp-new-cancel">Cancel</button>
      </div>
    `;
    dropdown.appendChild(form);
    openDropdown();

    // Stop ALL click and mousedown events inside the form from reaching parent handlers
    form.addEventListener('mousedown', e => e.stopPropagation());
    form.addEventListener('click',     e => e.stopPropagation());

    const saveBtn  = form.querySelector('#cp-new-save');
    const errEl    = form.querySelector('#cp-new-error');

    form.querySelector('#cp-new-name').focus();

    saveBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const nameVal  = form.querySelector('#cp-new-name').value.trim();
      const dobVal = form.querySelector('#cp-new-dob').value || null;

      if (!nameVal) {
        errEl.textContent = 'Name is required.';
        form.querySelector('#cp-new-name').focus();
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      errEl.textContent = '';

      try {
        // Quick-add creates a directory person; institution/role are assigned in HR.
        const { data, error } = await sb.from('personnel').insert({
          name:          nameVal,
          date_of_birth: dobVal,
          active:        true,
        }).select().single();

        if (error) {
          console.error('[contactPicker] insert error:', error);
          errEl.textContent = 'Failed: ' + error.message;
          saveBtn.disabled = false;
          saveBtn.textContent = 'Add & select';
          return;
        }

        console.log('[contactPicker] created:', data);
        if (store.personnel) store.personnel.push(data);
        select(data);

      } catch (err) {
        console.error('[contactPicker] unexpected error:', err);
        errEl.textContent = 'Unexpected error — see console';
        saveBtn.disabled = false;
        saveBtn.textContent = 'Add & select';
      }
    });

    form.querySelector('#cp-new-cancel').addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      closeDropdown();
    });
  }

  // ── Search (filters store.personnel; falls back to Supabase if store empty)

  function search(query) {
    const q = query.toLowerCase().trim();
    if (!q) { closeDropdown(); return; }

    const pool = store.personnel;
    if (pool?.length) {
      const results = pool
        .filter(p => personLabel(p).toLowerCase().includes(q))
        .slice(0, 8);
      renderResults(results, query);
    } else {
      // Fallback: query Supabase directly
      sb.from('personnel')
        .select('id,name,institution')
        .ilike('name', `%${q}%`)
        .eq('active', true)
        .limit(8)
        .then(({ data }) => renderResults(data || [], query));
    }
  }

  // ── Events

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => search(input.value), 200);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim()) search(input.value);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDropdown();
  });

  // Close on outside click
  const outsideHandler = e => {
    if (!container.contains(e.target)) closeDropdown();
  };
  document.addEventListener('mousedown', outsideHandler);

  // ── Initial value

  if (initialValue) {
    const existing = (store.personnel || []).find(p => p.id === initialValue);
    if (existing) {
      select(existing);
    } else {
      sb.from('personnel').select('id,name,institution').eq('id', initialValue).single()
        .then(({ data }) => { if (data) select(data); });
    }
  }

  // ── Public API

  return {
    getValue:  () => multiSelect ? [..._selectedPersons] : selectedPerson,
    getId:     () => multiSelect ? _selectedPersons.map(p => p.id) : (selectedPerson?.id || null),
    clear:     () => {
      if (multiSelect) {
        chipsRow.innerHTML = '';
        chipsRow.style.marginBottom = '0';
        _selectedPersons = [];
      } else {
        const chip = container.querySelector('.cp-chip');
        if (chip) chip.remove();
        selectedPerson = null;
        input.style.display = '';
      }
      input.value = '';
    },
    destroy:   () => document.removeEventListener('mousedown', outsideHandler),
  };
}
