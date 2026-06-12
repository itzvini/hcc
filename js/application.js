import { t } from './i18n.js';

// Candidate self-nomination form. Mounted by apply.js when a signed-in holder is
// eligible to run. Server re-checks eligibility on every save (never trust client).
// Question ids must match APPLICATION_QUESTIONS in server.js.

const QUESTIONS = ['track', 'theme', 'gen2', 'value', 'roadmap', 'communication', 'represent', 'seat'];
const CONSENTS  = ['seat', 'publish', 'hold'];
const LIMITS    = { displayName: 40, pitch: 240, answer: 1200 };
const BRACKET_KEY = { single: 'apply.bracket.single', mid: 'apply.bracket.mid', whale: 'apply.bracket.whale' };

// Set while the application flow owns #apply-app, so a language switch re-renders
// the form (in the new language, keeping entered values) instead of the apply.js
// eligibility card clobbering it.
let active = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function postApplication(payload) {
  const res = await fetch('/api/application', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function field(id, label, value, { textarea = false, max, ph = '', hint = '' } = {}) {
  const counter = max ? `<span class="appf-count" data-for="${id}">${(value || '').length}/${max}</span>` : '';
  const control = textarea
    ? `<textarea id="appf-${id}" class="appf-input" rows="4" maxlength="${max}" placeholder="${esc(ph)}">${esc(value || '')}</textarea>`
    : `<input id="appf-${id}" class="appf-input" type="text" maxlength="${max}" value="${esc(value || '')}" placeholder="${esc(ph)}" />`;
  return `
    <div class="appf-field" data-field="${id}">
      <label class="appf-label" for="appf-${id}">${esc(label)} ${counter}</label>
      ${control}
      ${hint ? `<p class="appf-hint">${esc(hint)}</p>` : ''}
    </div>`;
}

// Candidate identity preview — the Highrise avatar + ballot name voters will see.
function candidatePreview(data) {
  const avatar = data.avatar
    ? `<img class="app-cand-avatar" src="${esc(data.avatar)}" alt="" loading="lazy" />`
    : '<div class="app-cand-avatar app-cand-fallback" aria-hidden="true">👤</div>';
  return `
    <div class="app-candidate">
      <div class="app-cand-ring">${avatar}</div>
      <div class="app-cand-text">
        <div class="app-cand-label">${esc(t('app.field.name.label'))}</div>
        <div class="app-cand-name">${esc(data.ballotName || '—')}</div>
      </div>
    </div>`;
}

function submittedView(data) {
  const app = data.application || {};
  const canEdit = data.canEdit !== false; // editable until voting begins
  const answers = app.answers || {};
  const rows = QUESTIONS.map(id => `
    <div class="appf-review">
      <div class="appf-review-q">${esc(t(`app.q.${id}.q`))}</div>
      <div class="appf-review-a">${esc(answers[id] || '—')}</div>
    </div>`).join('');
  const positions = app.positions || {};
  const posRows = (data.propositions || []).map(p => {
    const cur = positions[p.id];
    if (!cur) return '';
    return `
      <div class="appf-review">
        <div class="appf-review-q">${esc(t('prop.' + p.id))}</div>
        <div class="appf-review-a"><strong>${esc(t('app.scale.' + cur.stance))}</strong>${cur.rationale ? ` — ${esc(cur.rationale)}` : ''}</div>
      </div>`;
  }).join('');
  return `
    <div class="application" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="app-success">
        <div class="app-success-ico" aria-hidden="true">🏛️</div>
        <span class="apply-pill">${esc(t('app.submitted.badge'))}</span>
        <h3>${esc(t('app.submitted.h'))}</h3>
        <p>${esc(canEdit ? t('app.submitted.p') : t('app.locked.note'))}</p>
      </div>
      ${data.justUpdated ? `<div class="appf-msg is-ok" role="status">${esc(t('app.updated'))}</div>` : ''}
      ${candidatePreview(data)}
      <div class="appf-summary">
        <div class="appf-review"><div class="appf-review-q">${esc(t('app.field.pitch.label'))}</div><div class="appf-review-a">${esc(app.pitch || '—')}</div></div>
        ${rows}
        ${posRows}
      </div>
      <div class="appf-actions">
        <button class="apply-btn-ghost" type="button" id="app-back">${esc(t('app.back'))}</button>
        ${canEdit ? `<button class="appf-btn-primary" type="button" id="app-edit">${esc(t('app.edit'))}</button>` : ''}
      </div>
    </div>`;
}

// VAA positions: a 1-5 scale + optional rationale per proposition, with an
// "AI-draft from my answers" button. Statement text comes from i18n (prop.<id>).
function positionsSection(data) {
  const isUpdate = data.application?.status === 'submitted';
  const open = isUpdate ? data.canEdit !== false : data.applicationsOpen !== false;
  const saved = (data.application && data.application.positions) || {};
  const rows = (data.propositions || []).map(p => {
    const cur = saved[p.id] || {};
    const scale = [1, 2, 3, 4, 5].map(v => `
      <label class="vaa-opt" title="${esc(t('app.scale.' + v))}">
        <input type="radio" name="pos-${esc(p.id)}" value="${v}" ${cur.stance === v ? 'checked' : ''} />
        <span class="vaa-dot"></span>
        <span class="vaa-opt-label">${esc(t('app.scale.' + v))}</span>
      </label>`).join('');
    return `
      <div class="vaa-prop" data-prop="${esc(p.id)}">
        <div class="vaa-statement">${esc(t('prop.' + p.id))}</div>
        <div class="vaa-scale">${scale}</div>
        <input type="text" class="appf-input vaa-rationale" maxlength="200" placeholder="${esc(t('app.rationale.ph'))}" value="${esc(cur.rationale || '')}" />
      </div>`;
  }).join('');
  return `
    <div class="appf-divider"><span>${esc(t('app.positions.title'))}</span></div>
    <p class="appf-hint">${esc(t('app.positions.intro'))}</p>
    <div class="vaa-derive">
      <button class="appf-ai-btn" type="button" id="app-derive" ${open ? '' : 'disabled'} title="${open ? '' : esc(t('app.closed.note'))}">✨ <span class="appf-ai-label">${esc(t('app.derive'))}</span></button>
      <span class="appf-hint">${esc(open ? t('app.derive.hint') : t('app.closed.note'))}</span>
    </div>
    <div class="vaa-props">${rows}</div>`;
}

function formView(data) {
  const app = data.application || {};
  const answers = app.answers || {};
  const isUpdate = app.status === 'submitted';  // editing a live candidacy, not drafting
  // First submissions unlock with the candidacy window; edits to a live candidacy
  // stay open until voting begins. The AI draft follows the same gate (so does the server).
  const open = isUpdate ? data.canEdit !== false : data.applicationsOpen !== false;
  const bracketLabel = data.bracket ? t(BRACKET_KEY[data.bracket]) : '';
  const draftBadge = app.status === 'draft' && app.updatedAt
    ? `<span class="appf-draft-badge">${esc(t('app.draft.badge'))}</span>` : '';

  const questionFields = QUESTIONS.map(id =>
    field(id, t(`app.q.${id}.q`), answers[id], { textarea: true, max: LIMITS.answer })
  ).join('');

  // Acknowledgements were already given at submission, so they start ticked on an edit.
  const consents = CONSENTS.map(id => `
    <label class="appf-consent">
      <input type="checkbox" id="appf-consent-${id}" ${isUpdate ? 'checked' : ''} />
      <span>${esc(t(`app.consent.${id}`))}</span>
    </label>`).join('');

  return `
    <div class="application" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="app-head">
        <div>
          <div class="eyebrow">${esc(t('app.eyebrow'))}</div>
          <h3 class="app-h">${esc(t('app.h'))}</h3>
        </div>
        ${bracketLabel ? `<span class="apply-tier" data-tier="${esc(data.bracket)}">${esc(bracketLabel)}</span>` : ''}
      </div>
      <p class="app-intro">${esc(t('app.intro'))} ${draftBadge}</p>
      ${open || isUpdate ? '' : `<div class="appf-banner" role="note">${esc(t('app.closed.banner'))}</div>`}
      ${isUpdate ? `<div class="appf-banner" role="note">${esc(t('app.editing.note'))}</div>` : ''}

      ${candidatePreview(data)}
      <p class="appf-hint appf-hint-name">${esc(t('app.field.name.hint'))}</p>
      ${field('pitch', t('app.field.pitch.label'), app.pitch, { textarea: true, max: LIMITS.pitch, ph: t('app.field.pitch.ph') })}

      <div class="appf-divider"><span>${esc(t('app.questions.title'))}</span></div>
      ${questionFields}

      ${positionsSection(data)}

      <div class="appf-consents">${consents}</div>

      <div class="appf-msg" id="app-msg" role="status" hidden></div>
      <div class="appf-actions">
        <button class="apply-btn-ghost" type="button" id="app-back">${esc(t(isUpdate ? 'app.cancel' : 'app.back'))}</button>
        ${isUpdate ? '' : `<button class="apply-btn-ghost" type="button" id="app-save">${esc(t('app.save'))}</button>`}
        <button class="appf-btn-primary" type="button" id="app-submit" ${open ? '' : 'disabled'} title="${open ? '' : esc(t('app.closed.note'))}">${esc(t(isUpdate ? 'app.update' : 'app.submit'))}</button>
      </div>
    </div>`;
}

function collect() {
  const val = id => (document.getElementById(`appf-${id}`)?.value || '').trim();
  const answers = {};
  for (const id of QUESTIONS) answers[id] = val(id);
  const positions = {};
  document.querySelectorAll('.vaa-prop').forEach(el => {
    const id = el.dataset.prop;
    const checked = el.querySelector('input[type="radio"]:checked');
    const rationale = (el.querySelector('.vaa-rationale')?.value || '').trim();
    if (checked) positions[id] = { stance: Number(checked.value), rationale };
    else if (rationale) positions[id] = { stance: 3, rationale };
  });
  const consent = CONSENTS.every(id => document.getElementById(`appf-consent-${id}`)?.checked);
  return { pitch: val('pitch'), answers, positions, consent }; // ballot name is server-set
}

// Preserve in-progress edits into the in-memory data before a re-render (e.g. on a
// language switch). No-op on the read-only submitted view (no inputs present).
function captureInto(data) {
  if (!data || !document.getElementById('appf-pitch')) return;
  const c = collect();
  data.application = { ...(data.application || {}), pitch: c.pitch, answers: c.answers, positions: c.positions };
}

function showMsg(kind, text) {
  const el = document.getElementById('app-msg');
  if (!el) return;
  el.hidden = false;
  el.className = `appf-msg is-${kind}`;
  el.textContent = text;
}

// Mount the application flow into `container`. onBack() returns to the eligibility view.
export async function openApplication(container, onBack) {
  active = null;
  container.innerHTML = '<div class="apply-loading"><div class="apply-spinner"></div></div>';

  let data;
  try {
    const res = await fetch('/api/application', { headers: { Accept: 'application/json' } });
    data = await res.json();
  } catch {
    container.innerHTML = `<div class="apply-member"><p class="apply-note">${esc(t('app.err.generic'))}</p></div>`;
    return;
  }

  if (!data.eligibleToRun) { onBack(); return; }

  const back = () => { active = null; onBack(); };
  let currentMode = 'view';

  const render = (mode) => {
    currentMode = mode;
    const submitted = data.application && data.application.status === 'submitted';
    container.innerHTML = (mode === 'view' && submitted)
      ? submittedView(data)
      : formView(data);
    bind(mode);
    data.justUpdated = false; // the "changes saved" flash shows once
  };

  const bind = (mode) => {
    const submitted = data.application && data.application.status === 'submitted';
    // While editing a live candidacy, "Cancel" discards unsaved edits and returns to
    // the summary; everywhere else the button leaves for the eligibility card.
    container.querySelector('#app-back')?.addEventListener('click',
      mode === 'edit' && submitted ? () => render('view') : back);
    container.querySelector('#app-edit')?.addEventListener('click', () => render('edit'));

    // Live character counters
    container.querySelectorAll('.appf-input[maxlength]').forEach(input => {
      const id = input.id.replace('appf-', '');
      const counter = container.querySelector(`.appf-count[data-for="${id}"]`);
      if (counter) input.addEventListener('input', () => { counter.textContent = `${input.value.length}/${input.maxLength}`; });
    });

    const save = async (status) => {
      const isUpdate = data.application?.status === 'submitted';
      const canSave = isUpdate ? data.canEdit !== false : data.applicationsOpen !== false;
      if (status === 'submitted' && !canSave) { showMsg('error', t(isUpdate ? 'app.locked.note' : 'app.closed.note')); return; }
      const payload = { ...collect(), status };
      if (status === 'submitted' && !payload.consent) { showMsg('error', t('app.err.consent')); return; }
      container.querySelectorAll('button').forEach(b => (b.disabled = true));
      showMsg('info', status === 'submitted' ? t(isUpdate ? 'app.updating' : 'app.submitting') : t('app.saving'));
      const { ok, status: code, data: res } = await postApplication(payload);
      container.querySelectorAll('button').forEach(b => (b.disabled = false));
      if (!ok) {
        showMsg('error', code === 422 ? t('app.err.required') : (res.error || t('app.err.generic')));
        return;
      }
      data.application = res.application;
      if (status === 'submitted') { data.justUpdated = isUpdate; render('view'); }
      else { showMsg('ok', t('app.saved')); }
    };

    // AI-draft positions from the open answers (candidate reviews/edits after).
    const deriveBtn = container.querySelector('#app-derive');
    deriveBtn?.addEventListener('click', async () => {
      const label = deriveBtn.querySelector('.appf-ai-label');
      const orig = label?.textContent;
      container.querySelectorAll('button').forEach(b => (b.disabled = true));
      if (label) label.textContent = t('app.deriving');
      try {
        const res = await fetch('/api/application/derive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: collect().answers }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(out.positions)) {
          for (const p of out.positions) {
            const el = container.querySelector(`.vaa-prop[data-prop="${p.id}"]`);
            if (!el) continue;
            const radio = el.querySelector(`input[value="${p.stance}"]`);
            if (radio) radio.checked = true;
            const r = el.querySelector('.vaa-rationale');
            if (r && !r.value) r.value = p.rationale || '';
          }
          showMsg('ok', t('app.derived.ok'));
        } else {
          showMsg('error', out.error || t('app.err.generic'));
        }
      } catch { showMsg('error', t('app.err.generic')); }
      container.querySelectorAll('button').forEach(b => (b.disabled = false));
      if (label && orig) label.textContent = orig;
    });

    container.querySelector('#app-save')?.addEventListener('click', () => save('draft'));
    container.querySelector('#app-submit')?.addEventListener('click', () => save('submitted'));
  };

  // Re-render the current view in the active language, keeping entered values.
  active = { rerender: () => { captureInto(data); render(currentMode); } };
  render('view');
}

// Called on language switch: if the application flow is open, re-render it (in the
// new language) and report that we handled the panel. Returns false if not active.
export function rerenderApplication() {
  if (!active) return false;
  active.rerender();
  return true;
}
