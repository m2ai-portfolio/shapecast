import { validatePartList } from './schema.js';
import { runPrintChecks } from './printcheck.js';
import { writeBinaryStl, concatTriangles } from './stl.js';
import { createRequestTracker, createSaveController } from './lifecycle.js';
import { builderPrompt, editorPrompt } from './prompts.js';
import { slugify, readmeText, truncateRequest } from './exportbundle.js';
import {
  FIELDS,
  applyFieldEdit,
  removePart,
  prepareImages,
  checkDocumentSizes,
  projectDocument,
  SAMPLE_LIST,
  META,
  geometryGate,
  createPartCache,
} from './model.js';
import { createViewport } from './viewport.js';

const $ = (id) => /** @type {any} */ (document.getElementById(id));
const caps = { sample: null, downloads: null, db: null, assets: null, user: null };
let imageLimits = null,
  uid = null,
  viewport = null,
  saveCtl = null;
const tracker = createRequestTracker();
const partCache = createPartCache();
const state = {
  project: null,
  unsavedRevisions: [],
  items: [],
  result: null,
  selectedId: null,
  layerUm: 50,
  inference: null,
  stale: null,
  pendingSwitch: null,
};

const canPersist = () => !!(caps.db && caps.assets && uid);
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function newProject(list = SAMPLE_LIST) {
  const now = Date.now();
  return {
    id: newId('p'),
    name: list.name,
    brief: '',
    scaleRef: '',
    photos: [],
    current: list,
    currentRevisionId: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------- messages ----------
function showError(text) {
  const m = $('message');
  m.textContent = text;
  m.classList.toggle('hidden', !text);
}
function note(text) {
  $('photoNote').textContent = text;
}
function setBusy(on, text) {
  $('status').textContent = text;
  $('buildBtn').disabled = on || !caps.sample;
  $('sendBtn').disabled = on || !caps.sample;
  $('stopBtn').classList.toggle('hidden', !on);
}
function addChat(role, text) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.textContent = text;
  $('chatLog').append(d);
  d.scrollIntoView({ block: 'nearest' });
}

// ---------- render ----------
function render() {
  const list = state.project.current;
  const v = validatePartList(list);
  if (!v.ok) {
    showError(v.errors[0]);
    return;
  }
  state.items = list.parts.map((part) => partCache.item(part));
  const anyFailed = state.items.some((it) => it.failed);
  state.result = runPrintChecks(state.items, {
    layerUm: state.layerUm,
    orientation: list.print.orientation,
  });
  viewport?.setItems(state.items, state.selectedId);
  renderParts();
  renderChecks(anyFailed);
  renderAssumptions();
  renderThumbs();
  $('projectName').value = state.project.name;
  $('brief').value = state.project.brief;
  $('scaleRef').value = state.project.scaleRef;
  $('bboxReadout').textContent = state.result.bbox
    ? state.result.bbox.size.map((x) => x.toFixed(1)).join(' x ') + ' mm'
    : '';
  $('exportBtn').disabled = anyFailed || !caps.downloads;
  if (anyFailed)
    $('exportNote').textContent = 'Export is disabled until every part passes the geometry check.';
}

function renderParts() {
  const tbody = $('partsTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const it of state.items) {
    const p = it.part,
      tr = document.createElement('tr');
    tr.dataset.id = p.id;
    if (p.id === state.selectedId) tr.className = 'sel';
    const tdId = document.createElement('td');
    tdId.textContent = p.id;
    if (it.failed) {
      tdId.style.color = 'var(--red)';
      tdId.title = it.failure;
    }
    const tdType = document.createElement('td');
    tdType.textContent = p.type;
    const tdDims = document.createElement('td');
    for (const field of FIELDS[p.type]) {
      const wrap = document.createElement('div');
      wrap.className = 'tuple';
      const lab = document.createElement('span');
      lab.className = 'small';
      lab.textContent = field;
      wrap.append(lab);
      const isTuple = Array.isArray(p[field]);
      const vals = isTuple ? p[field] : [p[field]];
      vals.forEach((val, i) => {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.inputMode = 'decimal';
        inp.id = `f-${p.id}-${field}-${i}`;
        inp.value = val ?? '';
        inp.placeholder = field === 'radiusTop' ? '= radius' : field === 'segments' ? '64' : '';
        inp.dataset.id = p.id;
        inp.dataset.field = field;
        inp.dataset.index = isTuple ? String(i) : '';
        inp.addEventListener('change', onFieldChange);
        wrap.append(inp);
      });
      tdDims.append(wrap);
    }
    const tdX = document.createElement('td');
    const del = document.createElement('button');
    del.textContent = 'x';
    del.title = 'Remove part';
    del.addEventListener('click', () => {
      const r = removePart(state.project.current, p.id);
      if (r.ok) applyList(r.list);
      else showError(r.error);
    });
    tdX.append(del);
    tr.append(tdId, tdType, tdDims, tdX);
    tr.addEventListener('click', (e) => {
      const tag = /** @type {HTMLElement} */ (e.target).tagName;
      if (tag !== 'INPUT' && tag !== 'BUTTON') {
        state.selectedId = p.id;
        render();
      }
    });
    tbody.append(tr);
  }
}
function onFieldChange(e) {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const { id, field, index } = input.dataset;
  if (input.value.trim() === '' && (field === 'radiusTop' || field === 'segments')) {
    const next = JSON.parse(JSON.stringify(state.project.current));
    delete next.parts.find((p) => p.id === id)[field];
    const v = validatePartList(next);
    if (v.ok) applyList(next);
    else showError(v.errors[0]);
    return;
  }
  const r = applyFieldEdit(
    state.project.current,
    id,
    field,
    index === '' ? null : Number(index),
    input.value,
  );
  if (r.ok) {
    showError('');
    applyList(r.list);
  } else {
    showError(r.error);
    render();
  }
}
function renderChecks(anyFailed) {
  const box = $('checks');
  box.innerHTML = '';
  const failed = anyFailed
    ? state.items
        .filter((i) => i.failed)
        .map((i) => ({
          level: 'red',
          message: `${i.part.id}: geometry failed manifold check (${i.failure})`,
        }))
    : [];
  for (const c of [...failed, ...state.result.checks]) {
    const d = document.createElement('div');
    d.className = `chip ${c.level}`;
    d.textContent = c.message;
    box.append(d);
  }
}
function renderAssumptions() {
  const a = state.project.current.assumptions,
    el = $('assumptions');
  el.classList.toggle('hidden', !a.length);
  el.innerHTML = '';
  const h = document.createElement('strong');
  h.textContent = 'Assumptions';
  const ul = document.createElement('ul');
  for (const s of a) {
    const li = document.createElement('li');
    li.textContent = s;
    ul.append(li);
  }
  el.append(h, ul);
}
function renderThumbs() {
  const t = $('thumbs');
  t.innerHTML = '';
  for (const ph of state.project.photos) {
    const d = document.createElement('div');
    d.className = 'thumb' + (canPersist() && !ph.assetId ? ' pending' : '');
    const img = document.createElement('img');
    img.alt = 'photo';
    img.src = ph.url || '/_blob/' + ph.assetId;
    const b = document.createElement('button');
    b.textContent = 'x';
    b.title = 'Remove photo';
    b.addEventListener('click', () => {
      state.project.photos = state.project.photos.filter((p) => p !== ph);
      saveCtl.setPendingUploads(
        canPersist() ? state.project.photos.filter((p) => !p.assetId).length : 0,
      );
      saveCtl.markChanged();
      renderThumbs();
    });
    d.append(img, b);
    t.append(d);
  }
}

// ---------- model changes ----------
function assetIds() {
  return state.project.photos.filter((p) => p.assetId).map((p) => p.assetId);
}
function applyList(list, { request = null, rename = false } = {}) {
  const now = Date.now();
  const rev = request
    ? {
        id: newId('r'),
        projectId: state.project.id,
        doc: { at: now, request: truncateRequest(request), partList: list },
      }
    : null;
  const prospective = projectDocument({
    ...state.project,
    name: rename && typeof list.name === 'string' ? list.name : state.project.name,
    photoAssetIds: assetIds(),
    current: list,
    currentRevisionId: rev?.id ?? state.project.currentRevisionId,
    updatedAt: now,
  });
  const size = checkDocumentSizes({ projectDoc: prospective, revisionDoc: rev?.doc });
  if (!size.ok) {
    showError(size.error);
    return false;
  }
  const gate = geometryGate(list);
  if (!gate.ok) {
    showError(`Rejected, the previous model is kept: ${gate.errors[0]}`);
    return false;
  }
  state.project.current = list;
  state.project.updatedAt = now;
  if (rename && typeof list.name === 'string') state.project.name = list.name.slice(0, META.name);
  if (rev) {
    state.unsavedRevisions.push(rev);
    state.project.currentRevisionId = rev.id;
  }
  tracker.bump();
  saveCtl.markChanged();
  render();
  return true;
}
function metaChange() {
  const name = /** @type {HTMLInputElement} */ ($('projectName')).value,
    brief = /** @type {HTMLTextAreaElement} */ ($('brief')).value,
    scaleRef = /** @type {HTMLInputElement} */ ($('scaleRef')).value;
  const prospective = projectDocument({
    ...state.project,
    name,
    brief,
    scaleRef,
    photoAssetIds: assetIds(),
  });
  const size = checkDocumentSizes({ projectDoc: prospective });
  if (!size.ok) {
    showError(size.error);
    return;
  }
  state.project.name = name.slice(0, META.name) || state.project.name;
  state.project.brief = brief.slice(0, META.brief);
  state.project.scaleRef = scaleRef.slice(0, META.scaleRef);
  saveCtl.markChanged();
}
function addPhotos(files) {
  for (const f of files) {
    if (state.project.photos.length >= META.photos) {
      note(`At most ${META.photos} photos per project.`);
      break;
    }
    state.project.photos.push({ localId: newId('ph'), file: f, url: URL.createObjectURL(f) });
  }
  if (canPersist())
    saveCtl.setPendingUploads(state.project.photos.filter((p) => !p.assetId).length);
  saveCtl.markChanged();
  renderThumbs();
}

// ---------- Claude ----------
async function runInference(kind, requestText) {
  if (!caps.sample || state.inference) return;
  const controller = new AbortController(),
    token = tracker.token();
  state.inference = { controller, token };
  setBusy(true, 'Thinking...');
  showError('');
  let prompt,
    images = [];
  if (kind === 'build') {
    const files = state.project.photos.map((p) => p.file).filter(Boolean);
    const prep = prepareImages(files, imageLimits);
    const stored = state.project.photos.length - files.length;
    const notes = prep.rejected.map((r) => `${r.name}: ${r.reason}`);
    if (stored)
      notes.push(
        `${stored} saved photo${stored > 1 ? 's' : ''} cannot be re-sent; add them again to use them`,
      );
    note(notes.join('; '));
    images = prep.images;
    if (!images.length && !state.project.brief.trim()) {
      showError(
        imageLimits
          ? 'Nothing to build from: add a usable photo or write a brief.'
          : 'Photos cannot be sent to Claude from this artifact yet (the runtime reports no image support for your account). Describe the object in the brief instead: what it is, its key dimensions, and one scale reference.',
      );
      state.inference = null;
      setBusy(false, '');
      return;
    }
    prompt = builderPrompt({
      brief: state.project.brief,
      scaleRef: state.project.scaleRef,
      imageCount: images.length,
    });
    addChat(
      'user',
      `Build: ${state.project.brief || '(photos only)'}${state.project.scaleRef ? ` [scale: ${state.project.scaleRef}]` : ''}`,
    );
  } else {
    prompt = editorPrompt({ partList: state.project.current, request: requestText });
    addChat('user', requestText);
  }
  try {
    const reply = await caps.sample.json(prompt, {
      signal: controller.signal,
      images: images.length ? images : undefined,
      modelTier: kind === 'build' ? 'complex' : 'quick',
      cache: false,
      onText: ({ text }) => {
        $('rawReply').textContent = text;
        setBusy(true, 'Writing...');
      },
    });
    const v = validatePartList(reply);
    if (!v.ok) {
      $('rawReply').textContent = JSON.stringify(reply, null, 2);
      showError(`Claude's reply was rejected: ${v.errors[0]}. Try again or simplify the request.`);
      return;
    }
    const request =
      kind === 'build' ? `build: ${state.project.brief || 'from photos'}` : requestText;
    if (token.projectId !== state.project.id) {
      showError('A result arrived for a different project and was discarded.');
      return;
    }
    if (!tracker.isCurrent(token)) {
      state.stale = { list: reply, request };
      $('staleText').textContent =
        'This result is for an older revision of the project (you edited or switched meanwhile).';
      $('staleCard').classList.remove('hidden');
      return;
    }
    if (applyList(reply, { request, rename: kind === 'build' })) {
      addChat(
        'claude',
        reply.assumptions.length ? reply.assumptions.join(' | ') : 'Model updated.',
      );
      if (kind === 'build') viewport?.fit(state.result.bbox);
    }
  } catch (e) {
    handleSampleError(e);
  } finally {
    state.inference = null;
    setBusy(false, '');
  }
}
function handleSampleError(e) {
  const code = e?.code || 'upstream_error';
  if (code === 'cancelled') return;
  if (
    [
      'not_granted',
      'sampling_disabled',
      'not_declared',
      'capability_disabled',
      'capability_removed',
    ].includes(code)
  ) {
    caps.sample = null;
    setBusy(false, 'Claude is not available for this artifact in this view.');
    return;
  }
  if (code === 'invalid_json') {
    $('rawReply').textContent = e.text || '';
    showError("Claude's reply was not valid JSON. Try again, or ask for a simpler model.");
    return;
  }
  if (code === 'refused') {
    $('rawReply').textContent = '';
    showError('Claude declined this request. Change the brief or photos and try again.');
    return;
  }
  const copy = {
    rate_limited: 'Too many requests right now. Wait a minute and try again.',
    session_expired: 'Your Claude session expired. Sign in again and retry.',
    image_rejected: 'A photo was rejected (type or size). Remove it and try again.',
    images_unavailable: 'This view cannot send photos; the brief alone will be used.',
    prompt_too_large:
      'The model is too large to send back for editing. Remove parts and try again.',
    empty_completion: 'Claude returned nothing. Simplify the request and try again.',
    upstream_error: 'Claude could not be reached. Try again in a moment.',
  };
  showError(copy[code] || copy.upstream_error);
}

// ---------- export ----------
async function exportFile(kind) {
  const list = state.project.current,
    slug = slugify(list.name);
  let data, filename;
  if (kind === 'zip') {
    const zip = new JSZip();
    zip.file(
      `${slug}.stl`,
      writeBinaryStl(concatTriangles(state.items.map((it) => it.tris)), list.name),
    );
    zip.file(`${slug}.json`, JSON.stringify(list, null, 2));
    zip.file('README.txt', readmeText({ list, result: state.result, layerUm: state.layerUm }));
    data = await zip.generateAsync({ type: 'blob' });
    filename = `shapecast-${slug}.zip`;
  } else {
    data = JSON.stringify(list, null, 2);
    filename = `shapecast-${slug}.json`;
  }
  try {
    const r = await caps.downloads.save({ filename, data });
    $('exportNote').textContent =
      r.status === 'saved'
        ? `Saved ${filename}.${kind === 'zip' ? ' Extract it and open the .stl in Chitubox.' : ''}`
        : '';
  } catch (e) {
    const c = e?.code;
    $('exportNote').textContent =
      c === 'declined'
        ? 'Export cancelled.'
        : c === 'rate_limited'
          ? 'A save is already open; finish it first.'
          : c === 'unavailable'
            ? 'Saving files is unavailable in this view.'
            : `Export failed (${c}).`;
    if (c === 'unavailable') {
      $('exportBtn').disabled = true;
      $('exportJsonBtn').disabled = true;
    }
  }
}

// ---------- persistence ----------
const projectsCol = () => caps.db.doc(`data/users/${uid}/workspace`).collection('projects');
async function saveProject(project, ctl) {
  // synchronous snapshot of this project's state at this generation; never read state.project below
  const snap = JSON.parse(JSON.stringify({ ...project, photos: undefined }));
  const unsaved = [...state.unsavedRevisions.filter((r) => r.projectId === project.id)];
  for (const ph of project.photos) {
    if (ph.assetId || !ph.file) continue;
    try {
      const r = await caps.assets.upload(ph.file);
      ph.assetId = r.id;
      ph.error = null;
    } catch (e) {
      ph.error = e?.code || 'upload failed';
    }
  }
  const pending = project.photos.filter((p) => !p.assetId).length;
  ctl.setPendingUploads(pending);
  if (project === state.project) renderThumbs();
  const doc = projectDocument({
    ...snap,
    photoAssetIds: project.photos.filter((p) => p.assetId).map((p) => p.assetId),
  });
  const size = checkDocumentSizes({ projectDoc: doc });
  if (!size.ok) throw new Error(size.error);
  await projectsCol().doc(snap.id).set(doc);
  const revCol = projectsCol().doc(snap.id).collection('revisions');
  for (const rev of unsaved) {
    const revSize = checkDocumentSizes({ revisionDoc: rev.doc });
    if (!revSize.ok) throw new Error(revSize.error);
    await revCol.doc(rev.id).set(rev.doc);
    state.unsavedRevisions = state.unsavedRevisions.filter((r) => r !== rev);
  }
  const all = await revCol.orderBy('at', 'asc').get();
  for (const d of all.docs.slice(0, Math.max(0, all.size - 20))) await revCol.doc(d.id).delete();
  if (pending) throw new Error(`${pending} photo${pending > 1 ? 's' : ''} not uploaded`);
}
function makeSaveCtl(project) {
  const ctl = createSaveController({
    save: canPersist() ? () => saveProject(project, ctl) : async () => {},
    onChange: (s) => {
      if (project !== state.project) return;
      $('saveState').textContent = !canPersist()
        ? 'local only'
        : s.error
          ? `Not saved: ${s.error.message}. Retry`
          : s.saving
            ? 'saving...'
            : s.dirty
              ? 'unsaved changes'
              : 'saved';
      $('saveState').style.cursor = s.error ? 'pointer' : '';
    },
  });
  if (!canPersist()) ctl.setAutosave(false);
  $('saveState').textContent = canPersist() ? 'saved' : 'local only';
  return ctl;
}
async function loadProjectList() {
  const q = await projectsCol().orderBy('updatedAt', 'desc').limit(50).get();
  const sel = $('projectSelect');
  sel.innerHTML = '<option value="">New project</option>';
  for (const d of q.docs) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = String(d.data().name);
    sel.append(o);
  }
  return q.docs;
}
function installProject(project) {
  saveCtl?.dispose();
  state.inference?.controller.abort();
  partCache.clear();
  state.project = project;
  state.unsavedRevisions = [];
  state.selectedId = null;
  state.stale = null;
  $('staleCard').classList.add('hidden');
  $('chatLog').innerHTML = '';
  $('rawReply').textContent = '';
  tracker.setProject(project.id);
  saveCtl = makeSaveCtl(project);
  /** @type {HTMLSelectElement} */ ($('projectSelect')).value = canPersist() ? project.id : '';
  render();
  viewport?.fit(state.result.bbox);
}
async function openProject(id) {
  const s = await projectsCol().doc(id).get();
  if (!s.exists) {
    showError('Project not found.');
    return;
  }
  const d = s.data();
  const v = validatePartList(d.current);
  if (!v.ok) {
    showError(`Stored project is invalid: ${v.errors[0]}`);
    return;
  }
  installProject({
    id,
    name: String(d.name),
    brief: String(d.brief ?? ''),
    scaleRef: String(d.scaleRef ?? ''),
    photos: /** @type {string[]} */ (d.photoAssetIds ?? []).map((a) => ({
      localId: a,
      assetId: a,
    })),
    current: d.current,
    currentRevisionId: d.currentRevisionId ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  });
}
function requestSwitch(action) {
  if (!saveCtl.isDirty()) return action();
  state.pendingSwitch = action;
  $('switchText').textContent = canPersist()
    ? 'This project has unsaved changes.'
    : 'This session is local only; unsaved changes will be lost.';
  $('switchSave').classList.toggle('hidden', !canPersist());
  $('switchSave').textContent = 'Save and switch';
  $('switchDialog').classList.remove('hidden');
}
async function doSwitchSave() {
  const main = document.querySelector('main');
  main.inert = true;
  const ok = await saveCtl.drain();
  main.inert = false;
  if (ok) {
    $('switchDialog').classList.add('hidden');
    await state.pendingSwitch();
  } else {
    $('switchText').textContent =
      `Could not save: ${saveCtl.state().error?.message ?? 'uploads pending'}. Retry, discard the unsaved changes, or stay.`;
    $('switchSave').textContent = 'Retry';
  }
}

// ---------- init ----------
async function init() {
  $('photoInput').addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    addPhotos([...input.files]);
    input.value = '';
  });
  const well = $('dropWell');
  well.addEventListener('dragover', (e) => {
    e.preventDefault();
    well.classList.add('over');
  });
  well.addEventListener('dragleave', () => well.classList.remove('over'));
  well.addEventListener('drop', (e) => {
    e.preventDefault();
    well.classList.remove('over');
    addPhotos([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
  });
  for (const id of ['projectName', 'brief', 'scaleRef'])
    $(id).addEventListener('change', metaChange);
  $('buildBtn').addEventListener('click', () => runInference('build'));
  $('sendBtn').addEventListener('click', () => {
    const box = /** @type {HTMLInputElement} */ ($('chatInput'));
    const t = box.value.trim();
    if (!t) return;
    box.value = '';
    runInference('edit', t);
  });
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('sendBtn').click();
  });
  $('stopBtn').addEventListener('click', () => state.inference?.controller.abort());
  $('staleApply').addEventListener('click', () => {
    if (state.stale && applyList(state.stale.list, { request: state.stale.request }))
      addChat('claude', 'Older result applied.');
    state.stale = null;
    $('staleCard').classList.add('hidden');
  });
  $('staleDiscard').addEventListener('click', () => {
    state.stale = null;
    $('staleCard').classList.add('hidden');
  });
  $('exportBtn').addEventListener('click', () => exportFile('zip'));
  $('exportJsonBtn').addEventListener('click', () => exportFile('json'));
  const layerSelect = /** @type {HTMLSelectElement} */ ($('layerSelect'));
  layerSelect.addEventListener('change', () => {
    state.layerUm = Number(layerSelect.value);
    try {
      localStorage.setItem('shapecast.layerUm', layerSelect.value);
    } catch {
      /* per-viewer convenience only */
    }
    render();
  });
  try {
    const l = localStorage.getItem('shapecast.layerUm');
    if (l) {
      state.layerUm = Number(l);
      layerSelect.value = l;
    }
  } catch {
    /* ignore */
  }
  $('fitBtn').addEventListener('click', () => viewport?.fit(state.result?.bbox));
  for (const v of ['iso', 'top', 'front'])
    $(`${v}Btn`).addEventListener('click', () => viewport?.view(v));
  $('newProjectBtn').addEventListener('click', () =>
    requestSwitch(async () => installProject(newProject())),
  );
  $('projectSelect').addEventListener('change', (e) => {
    const id = /** @type {HTMLSelectElement} */ (e.target).value;
    requestSwitch(async () => (id ? openProject(id) : installProject(newProject())));
  });
  $('switchSave').addEventListener('click', doSwitchSave);
  $('switchDiscard').addEventListener('click', async () => {
    $('switchDialog').classList.add('hidden');
    await state.pendingSwitch();
  });
  $('switchStay').addEventListener('click', () => {
    $('switchDialog').classList.add('hidden');
    /** @type {HTMLSelectElement} */ ($('projectSelect')).value = canPersist()
      ? state.project.id
      : '';
  });
  $('saveState').addEventListener('click', () => {
    if (saveCtl?.state().error) saveCtl.saveNow();
  });

  viewport = createViewport(/** @type {HTMLCanvasElement} */ ($('viewport')), {
    onSelect: (id) => {
      state.selectedId = id;
      render();
    },
  });
  if (!viewport) $('viewNotice').classList.remove('hidden');
  installProject(newProject());

  await Promise.all(
    Object.keys(caps).map(async (n) => {
      caps[n] = (await window.claude?.use(n)) ?? null;
    }),
  );
  if (caps.sample) {
    const lim = await caps.sample.limits().catch(() => null);
    imageLimits = lim?.images ?? null;
    if (!imageLimits)
      note('Photos cannot be sent to Claude from this artifact yet; the brief alone is used.');
    else
      /** @type {HTMLInputElement} */ ($('photoInput')).accept = imageLimits.mediaTypes.join(',');
    setBusy(false, '');
  } else setBusy(false, 'Claude is unavailable in this view; you can still edit and export.');
  if (!caps.downloads) {
    $('exportBtn').disabled = true;
    $('exportJsonBtn').disabled = true;
    $('exportNote').textContent = 'Saving files is unavailable in this view.';
  }
  uid = caps.user ? await caps.user.id().catch(() => null) : null;
  if (canPersist()) {
    const docs = await loadProjectList();
    if (docs.length) await openProject(docs[0].id);
    else installProject(state.project);
  } else {
    $('localBanner').classList.remove('hidden');
    saveCtl?.dispose();
    saveCtl = makeSaveCtl(state.project);
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
