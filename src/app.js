import { validatePartList } from './schema.js';
import {
  runPrintChecks,
  runMeshPrintChecks,
  estimateSaturn3Telemetry,
  transformMeshTriangles,
  maxCopiesOnSaturn3,
  packBuildPlate,
  computePeelForceProfile,
} from './printcheck.js';
import { writeBinaryStl, concatTriangles, parseStlBuffer } from './stl.js';
import { createRequestTracker, createSaveController } from './lifecycle.js';
import { builderPrompt, editorPrompt, criticPrompt } from './prompts.js';
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
  parseScaleRefMm,
  unpackForgePreview,
  shrinkPhotoForForge,
} from './model.js';
import { createViewport } from './viewport.js';

const FORGE_SERVER = 'ShapeCast Forge';
const QUALITY_THRESHOLD = 85;
const $ = (id) => /** @type {any} */ (document.getElementById(id));
const caps = { sample: null, downloads: null, db: null, assets: null, user: null, mcp: null };
let imageLimits = null,
  uid = null,
  viewport = null,
  saveCtl = null;
const tracker = createRequestTracker();
const partCache = createPartCache();
const state = {
  mode: 'forge',
  forgeReady: false,
  forgeMesh: null,
  meshTransform: { tiltDeg: 0, rotZDeg: 0, targetMm: null },
  packCount: 1,
  extraPlateMeshes: [],
  peelProfile: { areasMm2: new Float32Array(64), peakMm2: 0, peakRatioZ: 0, riskLevel: 'low' },
  vaultItems: [],
  activeVaultFile: '',
  turntable: false,
  uvScanAnim: null,
  lastBlenderCode: null,
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
  const canBuild =
    state.mode === 'forge'
      ? !!caps.mcp
      : state.mode === 'blender'
        ? !!caps.mcp
        : !!caps.sample;
  $('buildBtn').disabled = on || !canBuild;
  $('buildBtn').textContent =
    state.mode === 'forge'
      ? 'Generate mesh'
      : state.mode === 'blender'
        ? 'Build in Blender'
        : 'Build model';
  const rBtn = $('refineBtn');
  if (rBtn)
    rBtn.disabled =
      on || (state.mode === 'blender' ? !caps.mcp : !(caps.mcp && caps.sample));
  $('sendBtn').disabled =
    on || (state.mode === 'blender' ? !caps.mcp : !caps.sample);
  $('stopBtn').classList.toggle('hidden', !on);
}
function setMode(nextMode) {
  state.mode = nextMode === 'blocks' ? 'blocks' : nextMode === 'blender' ? 'blender' : 'forge';
  const modeSel = /** @type {HTMLSelectElement | null} */ ($('modeSelect'));
  if (modeSel) modeSel.value = state.mode;
  $('modeBtnForge')?.classList.toggle('primary', state.mode === 'forge');
  $('modeBtnBlender')?.classList.toggle('primary', state.mode === 'blender');
  $('modeBtnBlocks')?.classList.toggle('primary', state.mode === 'blocks');
  $('studioPrepWrap')?.classList.toggle('hidden', state.mode !== 'forge');
  $('blenderOptionsWrap')?.classList.toggle('hidden', state.mode !== 'blender');
  if (state.mode === 'blocks' && state.forgeMesh) {
    state.forgeMesh = null;
    render();
  }
  if (state.mode === 'forge') {
    note('Organic/Sculpt track: Step 0 Studio Prep -> Hunyuan3D 2.1 (512 octree) -> AlienPC STL.');
  } else if (state.mode === 'blender') {
    note(
      'Hard-Surface CAD track: OAuth Opus 5.5 / GPT-6.1-Sol writes exact Blender 4.3 bpy CAD (zero voxel remeshing).',
    );
  } else if (!imageLimits) {
    note('Parametric Blocks track.');
  }
  setBusy(Boolean(state.inference), $('status').textContent);
}
function addChat(role, text) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.textContent = text;
  $('chatLog').append(d);
  d.scrollIntoView({ block: 'nearest' });
}

function drawPeelSparkline(ratio = 1) {
  const cvs = /** @type {HTMLCanvasElement | null} */ ($('peelSparkline'));
  const badge = $('peelPeakBadge');
  if (!cvs) return;
  const ctx = cvs.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(180, cvs.clientWidth || 520);
  const h = Math.max(22, cvs.clientHeight || 26);
  if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
    cvs.width = Math.round(w * dpr);
    cvs.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { areasMm2, peakMm2, peakRatioZ, riskLevel } = state.peelProfile;
  const bins = areasMm2.length;
  if (!(peakMm2 > 0) || !bins) {
    if (badge) {
      badge.textContent = 'PEAK PEEL • —';
      badge.style.color = 'var(--muted)';
    }
    return;
  }

  const maxScale = Math.max(peakMm2 * 1.12, 350);
  const strokeColor =
    riskLevel === 'high' ? '#f87171' : riskLevel === 'moderate' ? '#fbbf24' : '#c084fc';
  const fillTop =
    riskLevel === 'high'
      ? 'rgba(248, 113, 113, 0.42)'
      : riskLevel === 'moderate'
        ? 'rgba(251, 191, 36, 0.36)'
        : 'rgba(168, 85, 247, 0.42)';

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, fillTop);
  grad.addColorStop(1, 'rgba(168, 85, 247, 0.03)');

  ctx.beginPath();
  ctx.moveTo(0, h - 1);
  for (let b = 0; b < bins; b++) {
    const x = (b / (bins - 1)) * w;
    const y = h - 2 - (areasMm2[b] / maxScale) * (h - 5);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h - 1);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  for (let b = 0; b < bins; b++) {
    const x = (b / (bins - 1)) * w;
    const y = h - 2 - (areasMm2[b] / maxScale) * (h - 5);
    if (b === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Peak dot
  const px = peakRatioZ * w;
  const py = h - 2 - (peakMm2 / maxScale) * (h - 5);
  ctx.beginPath();
  ctx.arc(px, py, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor;
  ctx.fill();

  // Active 405nm UV Slice Playhead
  if (ratio < 0.999) {
    const cx = Math.max(1, Math.min(w - 1, ratio * w));
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.strokeStyle = '#e9d5ff';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    const curBin = Math.max(0, Math.min(bins - 1, Math.floor(ratio * (bins - 1))));
    const sliceArea = Math.round(areasMm2[curBin]);
    if (badge) {
      badge.textContent = `SLICE ${sliceArea.toLocaleString()} / PEAK ${Math.round(peakMm2).toLocaleString()} mm²`;
      badge.style.color = 'var(--uv-bright)';
    }
  } else if (badge) {
    const tag =
      riskLevel === 'high' ? 'HIGH SUCTION' : riskLevel === 'moderate' ? 'MOD FEP' : 'LOW SUCTION';
    badge.textContent = `PEAK ${Math.round(peakMm2).toLocaleString()} mm² • ${tag}`;
    badge.style.color =
      riskLevel === 'high'
        ? 'var(--red)'
        : riskLevel === 'moderate'
          ? 'var(--amber)'
          : 'var(--green)';
  }
}

function updateUvSliceHud() {
  const slider = /** @type {HTMLInputElement | null} */ ($('uvSliceRange'));
  const readout = $('uvSliceReadout');
  const bar = $('uvSlicerBar');
  if (!slider || !readout) return;
  const ratio = Number(slider.value) / 1000;
  const sz = state.result?.bbox?.size?.[2] ?? 0;
  const totalLayers = sz > 0 ? Math.max(1, Math.ceil(sz / (state.layerUm / 1000))) : 0;
  viewport?.setSliceRatio(ratio, sz);
  drawPeelSparkline(ratio);
  if (ratio >= 0.999 || totalLayers === 0) {
    bar?.classList.remove('slicing');
    readout.textContent =
      totalLayers > 0
        ? `FULL MESH • ${totalLayers.toLocaleString()} LAYERS`
        : 'FULL MESH • Z X-RAY READY';
  } else {
    bar?.classList.add('slicing');
    const curLayer = Math.max(1, Math.round(ratio * totalLayers));
    const curZ = (ratio * sz).toFixed(1);
    readout.textContent = `405nm X-RAY • L${curLayer}/${totalLayers} (${curZ} mm)`;
  }
}

function updateTelemetryCards() {
  const tel = estimateSaturn3Telemetry(state.result?.bbox, state.result?.volumeMm3 ?? 0, {
    layerUm: state.layerUm,
  });
  const ov = viewport?.getOverhangStats?.() ?? { overhangPct: 0, overhangMm2: 0 };
  if ($('telTime')) $('telTime').textContent = tel.printTimeLabel;
  if ($('telTimeSub'))
    $('telTimeSub').textContent =
      tel.platePct > 0 ? `${tel.platePct.toFixed(1)}% of Saturn 3 plate` : 'Elegoo Saturn 3 12K';
  if ($('telCost')) {
    $('telCost').textContent =
      tel.solidMl > 0
        ? tel.recommendHollow
          ? `$${tel.hollowCostUsd.toFixed(2)}`
          : `$${tel.solidCostUsd.toFixed(2)}`
        : '—';
  }
  if ($('telCostSub')) {
    $('telCostSub').textContent =
      tel.solidMl > 0
        ? tel.recommendHollow
          ? `${Math.round(tel.hollowGrams)}g hollow ($${tel.solidCostUsd.toFixed(2)} solid)`
          : `${Math.round(tel.solidGrams)}g (${tel.solidMl.toFixed(1)} mL)`
        : '8K Photopolymer';
  }
  if ($('telLayers'))
    $('telLayers').textContent = tel.layers > 0 ? tel.layers.toLocaleString() : '—';
  if ($('telLayersSub'))
    $('telLayersSub').textContent = `${state.layerUm} µm Z • 19×24 µm XY`;
  if ($('telOverhang')) {
    $('telOverhang').textContent =
      state.result?.bbox ? `${ov.overhangPct.toFixed(1)}%` : '—';
    $('telOverhang').style.color =
      ov.overhangPct > 18 ? 'var(--amber)' : ov.overhangPct > 0 ? 'var(--fg)' : 'var(--green)';
  }
  if ($('telOverhangSub')) {
    $('telOverhangSub').textContent =
      ov.overhangPct > 18
        ? 'Add medium supports in Chitubox'
        : ov.overhangPct > 2
          ? 'Light tree supports advised'
          : 'Minimal overhang stress';
  }
  updateUvSliceHud();
}

// ---------- render ----------
function render() {
  if (state.forgeMesh) {
    const fm = state.forgeMesh;
    const failed = !fm.manifold?.ok;
    const rawTris = fm.rawTris || fm.tris;
    const { tris, bbox, scaleFactor } = transformMeshTriangles(rawTris, state.meshTransform);
    const primaryBbox = bbox || fm.bbox;
    const baseVolMm3 = fm.rawVolumeMm3 ?? fm.volumeMm3 ?? 0;
    const singleVolMm3 = baseVolMm3 * Math.pow(scaleFactor, 3);

    const maxFit = maxCopiesOnSaturn3(primaryBbox);
    if ($('packMaxBtn')) {
      $('packMaxBtn').textContent = `\u26A1 Max Plate (${maxFit.count}\u00D7)`;
    }

    const specs = [];
    const copyCount = Math.max(1, state.packCount || 1);
    for (let k = 0; k < copyCount; k++) {
      specs.push({
        part: { id: k === 0 ? 'forge_mesh' : `forge_mesh_${k}`, type: 'mesh' },
        tris,
        bbox: primaryBbox,
        failed,
        failure: fm.manifold?.errors?.[0] ?? null,
      });
    }

    let extraVolMm3 = 0;
    state.extraPlateMeshes.forEach((ex, idx) => {
      const exOriented = transformMeshTriangles(ex.rawTris, {
        tiltDeg: state.meshTransform.tiltDeg,
        rotZDeg: state.meshTransform.rotZDeg,
        targetMm: null,
      });
      if (exOriented.bbox) {
        extraVolMm3 += ex.rawVolumeMm3 || 0;
        specs.push({
          part: { id: `vault_extra_${idx}`, type: 'mesh' },
          tris: exOriented.tris,
          bbox: exOriented.bbox,
          failed: false,
          failure: null,
        });
      }
    });

    const packed = packBuildPlate(specs);
    const totalVolMm3 = singleVolMm3 * copyCount + extraVolMm3;
    const totalVolMl = Number((totalVolMm3 / 1000).toFixed(2));
    const totalParts = packed.items.length;

    state.items = packed.items;
    state.result = runMeshPrintChecks(packed.bbox || primaryBbox, totalVolMm3, !failed, {
      layerUm: state.layerUm,
    });
    state.peelProfile = computePeelForceProfile(state.items, state.result.bbox);
    viewport?.setItems(state.items, state.selectedId);
    $('partsTableWrap')?.classList.add('hidden');
    $('orientDeck')?.classList.remove('hidden');
    if ($('orientLabel')) {
      $('orientLabel').textContent = `${state.meshTransform.tiltDeg}° tilt • ${state.meshTransform.rotZDeg}° Z`;
    }
    if ($('packCountLabel')) {
      $('packCountLabel').textContent =
        totalParts === 1 ? '1 part on plate' : `${totalParts} parts nested`;
    }
    $('clearExtraBtn')?.classList.toggle('hidden', state.extraPlateMeshes.length === 0);

    const savingsEl = $('batchSavingsBadge');
    if (savingsEl) {
      if (totalParts > 1 && state.result.bbox) {
        const tel = estimateSaturn3Telemetry(state.result.bbox, totalVolMm3, {
          layerUm: state.layerUm,
        });
        const minsPerPart = Math.max(1, Math.round(tel.printMinutes / totalParts));
        const savedMins = Math.max(1, (totalParts - 1) * tel.printMinutes);
        const sHrs = Math.floor(savedMins / 60);
        const sRem = savedMins % 60;
        const savedStr = sHrs > 0 ? `${sHrs}h ${String(sRem).padStart(2, '0')}m` : `${sRem}m`;
        savingsEl.textContent = `\u26A1 ${totalParts}\u00D7 parts cured in one ${tel.printTimeLabel} Z-cycle (${minsPerPart}m/part \u2022 ${savedStr} saved vs solo runs)`;
        savingsEl.classList.remove('hidden');
      } else {
        savingsEl.classList.add('hidden');
      }
    }

    const sum = $('forgeSummary');
    if (sum) {
      sum.classList.remove('hidden');
      const stlTris = fm.qualityMetrics?.stl_faces;
      const triLabel =
        stlTris && stlTris > fm.triangleCount
          ? `${Number(stlTris).toLocaleString()} STL tris (${fm.triangleCount.toLocaleString()} preview)`
          : `${fm.triangleCount.toLocaleString()} tris`;
      const engineTag = fm.qualityMetrics?.pythonCode ? 'Blender 4.3 CAD' : 'Hunyuan3D 2.1';
      sum.textContent = `${engineTag} (${totalParts}\u00D7): ${triLabel} | ${totalVolMl} mL | ${fm.stlPath}`;
    }
    renderChecks(failed);
    $('assumptions').classList.add('hidden');
    renderThumbs();
    $('projectName').value = state.project.name;
    $('brief').value = state.project.brief;
    $('scaleRef').value = state.project.scaleRef;
    $('bboxReadout').textContent = state.result.bbox
      ? state.result.bbox.size.map((x) => x.toFixed(1)).join(' x ') + ' mm'
      : '';
    const canExportMesh = !failed && !!caps.downloads && fm.preview?.isFullMesh !== false;
    $('exportBtn').disabled = !canExportMesh;
    $('exportNote').textContent = fm.stlPath ? `${fm.stlPath}` : '';
    updateTelemetryCards();
    return;
  }

  $('orientDeck')?.classList.add('hidden');
  $('partsTableWrap')?.classList.remove('hidden');
  $('forgeSummary')?.classList.add('hidden');
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
  state.peelProfile = computePeelForceProfile(state.items, state.result.bbox);
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
  updateTelemetryCards();
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
  const pipWrap = $('refPipWrap');
  const pipImg = /** @type {HTMLImageElement | null} */ ($('refPipImg'));
  const firstPh = state.project.photos[0];
  if (pipWrap && pipImg) {
    if (firstPh) {
      pipImg.src = firstPh.url || '/_blob/' + firstPh.assetId;
      pipWrap.classList.remove('hidden');
    } else {
      pipImg.removeAttribute('src');
      pipWrap.classList.add('hidden');
    }
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
  state.forgeMesh = null;
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
  if (files.length > 0) {
    // Attaching a new reference photo starts a fresh visual reference context
    state.lastBlenderCode = null;
  }
  if (canPersist())
    saveCtl.setPendingUploads(state.project.photos.filter((p) => !p.assetId).length);
  saveCtl.markChanged();
  renderThumbs();
}

// ---------- Mesh Forge & Standalone LAN Studio ----------
const UI_VERSION = '6.0.0';
const STARTER_BRIEFS = {
  isd: {
    mode: 'blender',
    presetKey: 'star_destroyer_engines',
    scaleMm: 120,
    name: 'stardestroyer-engines-cad',
    scaleRef: '120 mm longest side',
    brief:
      'Imperial Star Destroyer rear diamond-wedge engine baffle plate (120 mm wide x 32 mm tall) with raised perimeter armor bevel frame, 3 large concentric 64-segment heavy ion thrusters with 28 radial internal turbine cooling vanes, 4 secondary thrusters on stepped mounting plates with micro-capacitor greeble blocks, radial structural struts around the center thruster, and 7-slat wingtip cooling louver arrays on both sides.',
  },
  turret: {
    mode: 'blender',
    presetKey: 'scifi_turret_battery',
    scaleMm: 85,
    name: 'quad-turbolaser-turret-cad',
    scaleRef: '85 mm longest side',
    brief:
      'Heavy sci-fi quad-barrel turbolaser turret battery on an octagonal armored rotating base with perimeter bolt flanges, twin elevated trunnion recoil housings, 4 concentric 64-segment stepped rifle barrels with muzzle flash suppressors and cooling jackets, top rangefinder optics pod, and rear heat-sink louver slats.',
  },
  mecha: {
    mode: 'forge',
    presetKey: '',
    scaleMm: 75,
    name: 'cyber-ronin-collectible-bust',
    scaleRef: '75 mm longest side',
    brief:
      'Collectible 75mm resin display bust of an armored cybernetic Ronin warrior on a beveled octagonal plinth pedestal, layered horned kabuto helmet with crisp mechanical visor slit, braided throat guard collar plates, high-relief shoulder pauldrons, watertight solid forms suitable for 12K MSLA photopolymer printing.',
  },
};

function stopUvScanAnim() {
  if (state.uvScanAnim) {
    cancelAnimationFrame(state.uvScanAnim);
    state.uvScanAnim = null;
  }
  const btn = $('uvScanBtn');
  if (btn) {
    btn.classList.remove('active');
    btn.textContent = '\u25B6 405nm UV Scan';
  }
}

function resetMeshTransformUi() {
  state.meshTransform = { tiltDeg: 0, rotZDeg: 0, targetMm: null };
  state.packCount = 1;
  state.extraPlateMeshes = [];
  const deck = $('orientDeck');
  if (deck) {
    deck.querySelectorAll('[data-tilt]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tilt') === '0');
    });
  }
  $('platePackRow')
    ?.querySelectorAll('[data-pack]')
    .forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-pack') === '1');
    });
  $('rotZ90Btn')?.classList.remove('active');
  stopUvScanAnim();
  const slider = /** @type {HTMLInputElement | null} */ ($('uvSliceRange'));
  if (slider) slider.value = '1000';
}

function getApiBase() {
  return window.location.pathname.startsWith('/forge') ? '/forge/api' : '/api';
}

function renderVaultStrip() {
  const listEl = $('vaultList');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!state.vaultItems.length) {
    const empty = document.createElement('span');
    empty.className = 'small';
    empty.textContent = 'Generate a mesh or click + Import .STL to populate your plate.';
    listEl.append(empty);
    return;
  }
  for (const item of state.vaultItems) {
    const card = document.createElement('div');
    card.className = 'vault-item' + (state.activeVaultFile === item.filename ? ' active' : '');

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'v-load';
    loadBtn.dataset.vaultLoad = item.filename;
    loadBtn.title = `Load ${item.label} (${item.triangles.toLocaleString()} tris) onto build plate`;

    const dot = document.createElement('span');
    dot.className = 'swatch';
    dot.style.background = item.engine === 'blender' ? '#f59e0b' : '#a855f7';

    const title = document.createElement('span');
    title.textContent = item.label;

    const meta = document.createElement('span');
    meta.className = 'v-meta';
    meta.textContent = `${Math.max(1, Math.round(item.triangles / 1000))}k`;

    loadBtn.append(dot, title, meta);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'v-add';
    addBtn.dataset.vaultAdd = item.filename;
    addBtn.title = `Nest ${item.label} alongside current model on Saturn 3 plate`;
    addBtn.textContent = '+Plate';

    card.append(loadBtn, addBtn);
    listEl.append(card);
  }
}

async function refreshVaultList() {
  if (!caps.mcp?.isLanDirect && typeof window !== 'undefined' && window.claude) {
    renderVaultStrip();
    return;
  }
  try {
    const r = await fetch(`${getApiBase()}/vault`, { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    if (Array.isArray(data?.items)) {
      state.vaultItems = data.items;
      renderVaultStrip();
    }
  } catch {
    renderVaultStrip();
  }
}

async function loadVaultStl(filename, { addToPlate = false } = {}) {
  const item = state.vaultItems.find((v) => v.filename === filename);
  if (!item) return;
  showError('');
  try {
    setBusy(true, `Streaming ${item.label} from Forge Vault...`);
    const r = await fetch(`${getApiBase()}/vault/stl?file=${encodeURIComponent(filename)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const parsed = parseStlBuffer(buf);

    if (addToPlate && state.forgeMesh) {
      state.extraPlateMeshes.push({
        id: newId('vx'),
        name: item.label,
        rawTris: parsed.tris,
        rawVolumeMm3: parsed.volumeMm3,
      });
      render();
      viewport?.fit(state.result?.bbox);
      return;
    }

    resetMeshTransformUi();
    state.activeVaultFile = filename;
    renderVaultStrip();
    state.forgeMesh = {
      ok: true,
      status: 'done',
      name: slugify(item.label),
      tris: parsed.tris,
      rawTris: parsed.tris,
      bbox: parsed.bbox,
      volumeMm3: parsed.volumeMm3,
      rawVolumeMm3: parsed.volumeMm3,
      triangleCount: parsed.triangleCount,
      manifold: { ok: true, errors: [] },
      stlPath: `Vault: ${filename}`,
      preview: { isFullMesh: true },
      qualityMetrics: item.engine === 'blender' ? { pythonCode: '# vault-cad' } : {},
    };
    state.project.name = slugify(item.label).slice(0, META.name);
    render();
    viewport?.fit(state.result?.bbox);
  } catch (e) {
    showError(`Could not load Vault STL: ${e?.message || 'failed'}`);
  } finally {
    setBusy(false, '');
  }
}

async function importLocalStlFiles(stlFiles) {
  if (!stlFiles.length) return;
  showError('');
  try {
    setBusy(true, `Parsing ${stlFiles.length} local STL file(s)...`);
    for (let idx = 0; idx < stlFiles.length; idx++) {
      const f = stlFiles[idx];
      const buf = await f.arrayBuffer();
      const parsed = parseStlBuffer(buf);
      const cleanName = slugify(f.name.replace(/\.stl$/i, ''));
      if (idx === 0 && !state.forgeMesh) {
        resetMeshTransformUi();
        state.activeVaultFile = '';
        renderVaultStrip();
        state.forgeMesh = {
          ok: true,
          status: 'done',
          name: cleanName,
          tris: parsed.tris,
          rawTris: parsed.tris,
          bbox: parsed.bbox,
          volumeMm3: parsed.volumeMm3,
          rawVolumeMm3: parsed.volumeMm3,
          triangleCount: parsed.triangleCount,
          manifold: { ok: true, errors: [] },
          stlPath: `Imported: ${f.name}`,
          preview: { isFullMesh: true },
          qualityMetrics: {},
        };
        state.project.name = cleanName.slice(0, META.name);
      } else if (idx === 0) {
        resetMeshTransformUi();
        state.activeVaultFile = '';
        renderVaultStrip();
        state.forgeMesh = {
          ok: true,
          status: 'done',
          name: cleanName,
          tris: parsed.tris,
          rawTris: parsed.tris,
          bbox: parsed.bbox,
          volumeMm3: parsed.volumeMm3,
          rawVolumeMm3: parsed.volumeMm3,
          triangleCount: parsed.triangleCount,
          manifold: { ok: true, errors: [] },
          stlPath: `Imported: ${f.name}`,
          preview: { isFullMesh: true },
          qualityMetrics: {},
        };
        state.project.name = cleanName.slice(0, META.name);
      } else {
        state.extraPlateMeshes.push({
          id: newId('stl'),
          name: cleanName,
          rawTris: parsed.tris,
          rawVolumeMm3: parsed.volumeMm3,
        });
      }
    }
    render();
    viewport?.fit(state.result?.bbox);
  } catch (e) {
    showError(`Invalid STL file: ${e?.message || 'parse failed'}`);
  } finally {
    setBusy(false, '');
  }
}
const CAD_PRESETS = {
  star_destroyer_engines: {
    name: 'stardestroyer-engines-cad',
    scaleRef: '120 mm wide',
    brief:
      'Imperial Star Destroyer rear diamond-wedge engine baffle plate (120 mm wide x 32 mm tall) with raised perimeter armor bevel frame, 3 large concentric 64-segment heavy ion thrusters with 28 radial internal turbine cooling vanes, 4 secondary thrusters on stepped mounting plates with micro-capacitor greeble blocks, radial structural struts around the center thruster, and 7-slat wingtip cooling louver arrays on both sides.',
  },
  star_destroyer_bridge: {
    name: 'stardestroyer-command-bridge-cad',
    scaleRef: '110 mm wide',
    brief:
      'Imperial Star Destroyer T-shaped command bridge tower sub-assembly with angled trapezoidal central neck, wide armored bridge hammerhead superstructure, forward recessed viewport trenches, twin 64-segment faceted geodesic shield generator domes on octagonal pedestals atop the roof, and dense multi-tiered surface panel trenches and cooling louver arrays.',
  },
  scifi_turret_battery: {
    name: 'quad-turbolaser-turret-cad',
    scaleRef: '85 mm wide',
    brief:
      'Heavy sci-fi quad-barrel turbolaser turret battery on an octagonal armored rotating base with perimeter bolt flanges, twin elevated trunnion recoil housings, 4 concentric 64-segment stepped rifle barrels with muzzle flash suppressors and cooling jackets, top rangefinder optics pod, and rear heat-sink louver slats.',
  },
  mech_bracket: {
    name: 'precision-servo-bracket-cad',
    scaleRef: '90 mm longest side',
    brief:
      'Precision L-shaped heavy-duty mechanical mounting bracket (90 mm x 60 mm x 50 mm, 5 mm wall thickness) with twin 45-degree triangular gusset ribs, 4 countersunk M5 base mounting bores with raised boss collars, and a central 24 mm flanged bearing bore on the vertical face.',
  },
};

function createLanMcpAdapter() {
  const apiBase = window.location.pathname.startsWith('/forge') ? '/forge/api' : '/api';
  return {
    isLanDirect: true,
    async callTool(_server, toolName, args = {}) {
      if (toolName === 'forge_status') {
        const r = await fetch(`${apiBase}/status`, { cache: 'no-store' });
        return { payload: await r.json() };
      }
      if (toolName === 'forge_generate') {
        const r = await fetch(`${apiBase}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        return { payload: await r.json() };
      }
      if (toolName === 'forge_job') {
        const q = encodeURIComponent(args.jobId || 'latest');
        const r = await fetch(`${apiBase}/job?jobId=${q}`, { cache: 'no-store' });
        return { payload: await r.json() };
      }
      if (toolName === 'forge_refine') {
        const r = await fetch(`${apiBase}/refine`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        return { payload: await r.json() };
      }
      throw new Error(`Unsupported tool: ${toolName}`);
    },
  };
}

function createLanSampleAdapter() {
  const apiBase = window.location.pathname.startsWith('/forge') ? '/forge/api' : '/api';
  return {
    async limits() {
      return {
        images: {
          maxCount: 4,
          maxBytes: 5_000_000,
          maxDimension: 1568,
          mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
        },
      };
    },
    async json(prompt, opts = {}) {
      const images = [];
      if (Array.isArray(opts.images)) {
        for (const img of opts.images) {
          if (typeof img === 'string') {
            images.push(img);
          } else if (img instanceof Blob) {
            const shrunk = await shrinkPhotoForForge(img);
            images.push(shrunk.base64);
          } else if (img?.data) {
            images.push(img.data);
          }
        }
      }
      const r = await fetch(`${apiBase}/sample`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, images }),
        signal: opts.signal,
      });
      const d = await r.json();
      if (!d?.ok) throw new Error(d?.error || 'OAuth sample request failed');
      if (opts.onText && d.text) opts.onText({ text: d.text });
      return d.json;
    },
  };
}

function createBrowserDownloadsAdapter() {
  return {
    async save({ filename, data }) {
      const blob =
        data instanceof Blob
          ? data
          : new Blob([data], {
              type: filename.endsWith('.json') ? 'application/json' : 'application/octet-stream',
            });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { status: 'saved' };
    },
  };
}
const STAGE_LABELS = {
  queued: 'Queued on AlienPC...',
  reference_image: '1/3 Step 0 Studio Prep (Gemini / ChatGPT / Flux)...',
  mesh_generation: '2/3 Sculpting 3D mesh (Hunyuan3D 2.1)...',
  repair_and_export: '3/3 Blender 4.3 crisp remesh & writing STL...',
};
const BLENDER_STAGE_LABELS = {
  queued: 'Queued on AlienPC...',
  reference_image: '1/2 Generating Blender 4.3 CAD Python (bpy) via OAuth Subscription...',
  mesh_generation: '2/2 Running headless Blender 4.3 Exact CAD export on AlienPC...',
  repair_and_export: '2/2 Exporting razor-sharp CAD STL on AlienPC...',
};

function saveLastForgeMeta(jobId) {
  try {
    localStorage.setItem(
      'shapecast.lastForgeMeta',
      JSON.stringify({
        jobId,
        name: state.project?.name || '',
        brief: state.project?.brief || '',
        scaleRef: state.project?.scaleRef || '',
        at: Date.now(),
      }),
    );
  } catch {
    /* ignore storage errors */
  }
}

function loadLastForgeMeta() {
  try {
    const raw = localStorage.getItem('shapecast.lastForgeMeta');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function resolveFirstPhotoBlob() {
  const first = state.project.photos[0];
  if (!first) return null;
  if (first.file) return first.file;
  const src = first.url || (first.assetId ? '/_blob/' + first.assetId : '');
  if (src) {
    try {
      const r = await fetch(src);
      if (r.ok) return await r.blob();
    } catch {
      /* fallback to rendered img element below */
    }
  }
  const imgEl = /** @type {HTMLImageElement | null} */ (
    document.querySelector('#thumbs .thumb img')
  );
  if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
    const c = document.createElement('canvas');
    c.width = imgEl.naturalWidth;
    c.height = imgEl.naturalHeight;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.drawImage(imgEl, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
      if (blob) return blob;
    }
  }
  return null;
}

async function refreshForgeStatus() {
  const badge = $('forgeBadge');
  const vBadge = $('versionBadge');
  if (!badge) return null;
  if (!caps.mcp) {
    badge.textContent = 'MCP unavailable';
    state.forgeReady = false;
    return null;
  }
  try {
    const r = await caps.mcp.callTool(FORGE_SERVER, 'forge_status', {}, { cache: false });
    const st = r?.payload;
    if (vBadge && st?.version) {
      vBadge.textContent = `UI v${UI_VERSION} • Forge v${st.version}${st.blender ? ` (Blender ${st.blender})` : ''}`;
    }
    if (st?.alienpc === 'available') {
      badge.textContent = 'AlienPC ready';
      badge.style.color = 'var(--green)';
      state.forgeReady = true;
    } else if (st?.alienpc === 'busy') {
      badge.textContent = 'AlienPC busy';
      badge.style.color = 'var(--amber)';
      state.forgeReady = false;
    } else {
      badge.textContent = 'AlienPC offline';
      badge.style.color = 'var(--red)';
      state.forgeReady = false;
    }
    return st;
  } catch {
    badge.textContent = 'connector offline';
    badge.style.color = 'var(--muted)';
    state.forgeReady = false;
    return null;
  }
}

async function restoreLatestForgeMeshIfAvailable({ onlyActive = false } = {}) {
  if (!caps.mcp || state.forgeMesh || state.inference || state.mode === 'blocks') return;
  try {
    const meta = loadLastForgeMeta();
    const st = await refreshForgeStatus();
    if (st?.activeJob?.jobId && !state.inference) {
      const controller = new AbortController();
      const token = tracker.token();
      state.inference = { controller, token };
      try {
        setBusy(true, `Reconnecting to running job ${st.activeJob.name || st.activeJob.jobId}...`);
        await pollForgeJobUntilDone(st.activeJob.jobId, controller);
      } finally {
        state.inference = null;
        setBusy(false, '');
      }
      return;
    }
    if (onlyActive || state.project?.photos?.length) return;
    if (meta && state.project) {
      if (!state.project.brief && meta.brief) state.project.brief = meta.brief;
      if (!state.project.scaleRef && meta.scaleRef) state.project.scaleRef = meta.scaleRef;
      if (state.project.name === SAMPLE_LIST.name && meta.name) state.project.name = meta.name;
    }
    const targetJobId = st?.lastJobId || meta?.jobId || 'latest';
    const res = await caps.mcp.callTool(
      FORGE_SERVER,
      'forge_job',
      { jobId: targetJobId },
      { cache: false },
    );
    const job = res?.payload;
    if (job?.ok && job?.status === 'done' && job?.preview) {
      const tris = unpackForgePreview(job.preview);
      resetMeshTransformUi();
      state.forgeMesh = { ...job, tris, rawTris: tris, rawVolumeMm3: job.volumeMm3 };
      if (job.qualityMetrics?.pythonCode) {
        state.lastBlenderCode = job.qualityMetrics.pythonCode;
      }
      if (job.name) state.project.name = String(job.name).slice(0, META.name);
      render();
      viewport?.fit(state.result?.bbox || job.bbox);
    }
  } catch {
    /* ignore if no prior job exists */
  }
}

async function pollForgeJobUntilDone(jobId, controller) {
  let transientErrors = 0;
  while (!controller.signal.aborted) {
    await new Promise((r) => setTimeout(r, 2500));
    if (controller.signal.aborted) return null;
    let pollRes;
    try {
      pollRes = await caps.mcp.callTool(FORGE_SERVER, 'forge_job', { jobId }, { cache: false });
      transientErrors = 0;
    } catch (pollErr) {
      transientErrors++;
      if (transientErrors <= 5 && !controller.signal.aborted) {
        setBusy(true, `Finishing mesh on AlienPC (reconnecting ${transientErrors}/5)...`);
        continue;
      }
      throw pollErr;
    }
    const job = pollRes?.payload;
    $('rawReply').textContent = JSON.stringify(
      {
        ...job,
        preview: job?.preview
          ? { ...job.preview, vertsBase64: '<omitted>', indicesBase64: '<omitted>' }
          : undefined,
      },
      null,
      2,
    );
    if (!job || job.status === 'error' || job.status === 'not_found') {
      showError(job?.error || 'Mesh Forge generation failed.');
      await refreshForgeStatus();
      return null;
    }
    if (job.status === 'running') {
      const labels = state.mode === 'blender' ? BLENDER_STAGE_LABELS : STAGE_LABELS;
      const label = labels[job.stage] || STAGE_LABELS[job.stage] || `Running (${job.stage})...`;
      setBusy(true, `${label} (${job.elapsedSec ?? 0}s)`);
      continue;
    }
    if (job.status === 'done') {
      const tris = unpackForgePreview(job.preview);
      resetMeshTransformUi();
      state.activeVaultFile = job.stlFilename || '';
      state.forgeMesh = { ...job, tris, rawTris: tris, rawVolumeMm3: job.volumeMm3 };
      if (job.qualityMetrics?.pythonCode) {
        state.lastBlenderCode = job.qualityMetrics.pythonCode;
      }
      if (job.name) state.project.name = String(job.name).slice(0, META.name);
      saveLastForgeMeta(job.jobId);
      saveCtl?.markChanged();
      render();
      viewport?.fit(state.result?.bbox || job.bbox);
      refreshVaultList();
      return job;
    }
  }
  return null;
}

async function runCriticStep({
  iteration = 1,
  maxIterations = 2,
  userFeedback = '',
  photoBase64,
  targetMm = 120,
  name = 'forge-model',
  controller,
}) {
  if (!caps.sample || !caps.mcp) return;
  const cStatus = $('criticStatus');
  for (let pass = iteration; pass <= maxIterations; pass++) {
    if (controller.signal.aborted) return;
    setBusy(true, `Critic Agent reviewing 3D mesh (pass ${pass}/${maxIterations})...`);

    const fm = state.forgeMesh;
    let criticImages = [];
    let hasPhotos = false;
    let hasRenderView = false;
    if (imageLimits) {
      const filesToSend = [];
      const refFile = state.project.photos.map((p) => p.file).find(Boolean);
      if (refFile) {
        filesToSend.push(refFile);
        hasPhotos = true;
      }
      if (viewport?.captureFourViews && fm?.bbox) {
        const viewFile = await viewport.captureFourViews(fm.bbox);
        if (viewFile) {
          filesToSend.push(viewFile);
          hasRenderView = true;
        }
      }
      if (filesToSend.length) {
        criticImages = prepareImages(filesToSend, imageLimits).images;
      }
    }

    const prompt = criticPrompt({
      brief: state.project.brief,
      scaleRef: state.project.scaleRef,
      userFeedback: pass === iteration ? userFeedback : '',
      bbox: fm?.bbox,
      triangleCount: fm?.triangleCount,
      volumeMl: fm?.volumeMl,
      qualityMetrics: fm?.qualityMetrics,
      iteration: pass,
      threshold: QUALITY_THRESHOLD,
      hasPhotos,
      hasRenderView,
    });

    const review = await caps.sample.json(prompt, {
      signal: controller.signal,
      images: criticImages.length ? criticImages : undefined,
      modelTier: 'complex',
      cache: false,
      onText: ({ text }) => {
        $('rawReply').textContent = text;
      },
    });
    if (!review || typeof review.score !== 'number') return;

    const score = Math.round(review.score);
    const issues = Array.isArray(review.missingOrOutOfPlace)
      ? review.missingOrOutOfPlace.slice(0, 3).join('; ')
      : '';
    if (cStatus) {
      cStatus.textContent = `Critic Score: ${score}/100 (target >= ${QUALITY_THRESHOLD}) — ${review.critique || ''}`;
      cStatus.style.color = score >= QUALITY_THRESHOLD ? 'var(--green)' : 'var(--amber)';
    }
    addChat(
      'claude',
      `Critic (Pass ${pass}): ${score}/100 — ${review.critique || ''}${issues ? ` | Focus: ${issues}` : ''}`,
    );

    if ((score >= QUALITY_THRESHOLD && !userFeedback) || review.action === 'accept') {
      return;
    }

    const rp = review.remeshParams || {};
    const aspectTarget =
      Array.isArray(rp.aspectRatioTarget) && rp.aspectRatioTarget.length === 3
        ? rp.aspectRatioTarget
        : undefined;

    if (review.action === 'regenerate_mesh') {
      setBusy(
        true,
        `Refining via Hunyuan3D Ultra-HD (octree ${review.octreeResolution || 512}, pass ${pass})...`,
      );
      const studioEngine =
        /** @type {HTMLSelectElement | null} */ ($('studioPrepSelect'))?.value || 'auto';
      const hdSpec = {
        prompt: review.refinedPrompt || state.project.brief || undefined,
        studioEngine,
        octreeResolution: review.octreeResolution || 512,
        steps: review.steps || 42,
        gridRes: rp.gridRes || 480,
        maxVerts: Math.min(rp.maxVerts || 46000, 48000),
        smoothIterations: rp.smoothIterations ?? 1,
        smoothFactor: rp.smoothFactor ?? 0.16,
        aspectRatioTarget: aspectTarget,
      };
      const startRes = await caps.mcp.callTool(
        FORGE_SERVER,
        'forge_generate',
        {
          prompt: '__FORGE_HD__:' + JSON.stringify(hdSpec),
          photoBase64,
          targetMm,
          name,
          seed: 731 + pass * 17,
        },
        { cache: false },
      );
      if (!startRes?.payload?.ok) {
        showError(startRes?.payload?.error || 'Could not start refinement pass.');
        return;
      }
      const nextJob = await pollForgeJobUntilDone(startRes.payload.jobId, controller);
      if (!nextJob) return;
      addChat(
        'claude',
        `Ultra-HD Regenerated: ${nextJob.triangleCount.toLocaleString()} preview tris / ${(nextJob.qualityMetrics?.stl_faces || nextJob.triangleCount).toLocaleString()} STL tris (${nextJob.bbox.size.map((x) => x.toFixed(1)).join(' x ')} mm).`,
      );
    } else {
      // Fast 3-second Blender 4.3 high-resolution crisp remesh + proportion correction on raw GLB
      setBusy(
        true,
        `Refining in Blender 4.3 (grid ${rp.gridRes || 480}, crisp creases & true proportions)...`,
      );
      const refineSpec = {
        rawGlbFilename: fm?.rawGlbFilename || undefined,
        gridRes: rp.gridRes || 480,
        maxVerts: Math.min(rp.maxVerts || 46000, 48000),
        smoothIterations: rp.smoothIterations ?? 1,
        smoothFactor: rp.smoothFactor ?? 0.16,
        aspectRatioTarget: aspectTarget,
      };
      const refStart = await caps.mcp.callTool(
        FORGE_SERVER,
        'forge_generate',
        {
          prompt: '__FORGE_REFINE__:' + JSON.stringify(refineSpec),
          targetMm,
          name,
        },
        { cache: false },
      );
      if (!refStart?.payload?.ok) {
        showError(refStart?.payload?.error || 'Blender refinement pass failed.');
        return;
      }
      const out = await pollForgeJobUntilDone(refStart.payload.jobId, controller);
      if (!out) return;
      addChat(
        'claude',
        `Refined mesh: ${out.triangleCount.toLocaleString()} crisp triangles (${out.bbox.size.map((x) => x.toFixed(1)).join(' x ')} mm). Written to AlienPC: ${out.stlPath}`,
      );
    }
    userFeedback = '';
  }
}

async function runCriticRefineLoop(userFeedback = '') {
  if (!caps.mcp || !caps.sample || state.inference) return;
  metaChange();
  const controller = new AbortController();
  const token = tracker.token();
  state.inference = { controller, token };
  showError('');

  const brief = state.project.brief.trim();
  const targetMm = parseScaleRefMm(state.project.scaleRef, 120);
  const customName =
    state.project.name && state.project.name !== SAMPLE_LIST.name ? state.project.name : '';
  const name = customName || brief.slice(0, 60) || 'refined-model';

  try {
    if (userFeedback) {
      addChat('user', `Refine mesh: ${userFeedback}`);
    } else {
      addChat('user', 'Run Quality Critic & Refinement Agent on current mesh');
    }
    let photoBase64;
    const photoBlob = await resolveFirstPhotoBlob();
    if (photoBlob) {
      const shrunk = await shrinkPhotoForForge(photoBlob);
      photoBase64 = shrunk.base64;
    }
    await runCriticStep({
      iteration: 1,
      maxIterations: 2,
      userFeedback,
      photoBase64,
      targetMm,
      name,
      controller,
    });
    await refreshForgeStatus();
  } catch (e) {
    if (!controller.signal.aborted) {
      showError(`Critic refinement error: ${e?.message || e?.code || 'failed'}`);
    }
  } finally {
    state.inference = null;
    setBusy(false, '');
  }
}

async function runForgeGenerate() {
  if (!caps.mcp || state.inference) return;
  metaChange();
  const controller = new AbortController();
  const token = tracker.token();
  state.inference = { controller, token };
  showError('');

  const brief = state.project.brief.trim();
  const photoBlob = await resolveFirstPhotoBlob();
  if (!brief && !photoBlob) {
    showError('Nothing to generate: write a brief or attach a photo.');
    state.inference = null;
    setBusy(false, '');
    return;
  }

  const targetMm = parseScaleRefMm(state.project.scaleRef, 120);
  const customName =
    state.project.name &&
    state.project.name !== SAMPLE_LIST.name &&
    state.project.name !== state.forgeMesh?.name
      ? state.project.name
      : '';
  const photoName =
    photoBlob && 'name' in photoBlob && typeof photoBlob.name === 'string'
      ? photoBlob.name.replace(/\.\w+$/, '')
      : '';
  const name = customName || brief.slice(0, 60) || photoName || 'forge-model';
  state.project.name = name.slice(0, META.name);
  $('projectName').value = state.project.name;

  try {
    let photoBase64;
    if (photoBlob) {
      setBusy(true, 'Preparing photo (shrinking <= 700 KB)...');
      const shrunk = await shrinkPhotoForForge(photoBlob);
      photoBase64 = shrunk.base64;
      note(`Sending photo to Mesh Forge (${Math.round(shrunk.blob.size / 1024)} KB JPEG).`);
    }

    const studioEngine =
      /** @type {HTMLSelectElement | null} */ ($('studioPrepSelect'))?.value || 'auto';
    setBusy(true, 'Contacting ShapeCast Forge on AlienPC...');
    addChat(
      'user',
      `Forge mesh (${targetMm} mm, Studio Prep: ${studioEngine}): ${brief || '(from photo)'}${photoBlob ? ' [+photo]' : ''}`,
    );

    const startRes = await caps.mcp.callTool(
      FORGE_SERVER,
      'forge_generate',
      {
        prompt: `[studio:${studioEngine}] ${brief}`.trim(),
        photoBase64,
        targetMm,
        name,
      },
      { cache: false },
    );
    const start = startRes?.payload;
    if (!start?.ok) {
      showError(start?.error || `Mesh Forge could not start (${start?.alienpc || 'error'}).`);
      await refreshForgeStatus();
      return;
    }

    const job = await pollForgeJobUntilDone(start.jobId, controller);
    if (!job) return;
    const prepNote = job.qualityMetrics?.studioPrep
      ? ` [Step 0: ${job.qualityMetrics.studioPrep}]`
      : '';
    addChat(
      'claude',
      `Mesh ready${prepNote}: ${job.triangleCount.toLocaleString()} watertight triangles (${job.bbox.size.map((x) => x.toFixed(1)).join(' x ')} mm). Written to AlienPC: ${job.stlPath}`,
    );

    const autoRefine = /** @type {HTMLInputElement | null} */ ($('autoRefineCheck'))?.checked;
    if (autoRefine && caps.sample && !controller.signal.aborted) {
      try {
        await runCriticStep({
          iteration: 1,
          maxIterations: 2,
          userFeedback: '',
          photoBase64,
          targetMm,
          name,
          controller,
        });
      } catch (criticErr) {
        const cStatus = $('criticStatus');
        if (cStatus) {
          cStatus.textContent = `Auto-refine skipped: ${criticErr?.message || 'unable to run critic pass'}`;
          cStatus.style.color = 'var(--amber)';
        }
      }
    }
    await refreshForgeStatus();
  } catch (e) {
    if (!controller.signal.aborted) {
      showError(`Mesh Forge error: ${e?.message || e?.code || 'connection failed'}`);
    }
  } finally {
    state.inference = null;
    setBusy(false, '');
  }
}

async function runBlenderGenerate(userFeedback = '') {
  if (!caps.mcp || state.inference) return;
  metaChange();
  const controller = new AbortController();
  const token = tracker.token();
  state.inference = { controller, token };
  showError('');

  const brief = state.project.brief.trim();
  const photoBlob = await resolveFirstPhotoBlob();
  if (!brief && !photoBlob && !userFeedback) {
    showError('Write a brief or attach a reference photo to build in Blender 3D.');
    state.inference = null;
    setBusy(false, '');
    return;
  }

  // Only treat as a revision when explicit userFeedback/refine instructions are given.
  // Clicking "Build in Blender" (userFeedback === '') must ALWAYS build from scratch!
  const isRevision = Boolean(userFeedback && state.lastBlenderCode);
  if (!isRevision) {
    state.lastBlenderCode = null;
  }
  const targetMm = parseScaleRefMm(state.project.scaleRef, 120);
  try {
    let photoBase64;
    if (photoBlob) {
      setBusy(true, 'Preparing reference photo for Blender 3D CAD...');
      const shrunk = await shrinkPhotoForForge(photoBlob);
      photoBase64 = shrunk.base64;
    } else if (isRevision && viewport?.captureFourViews && state.forgeMesh?.bbox) {
      const viewFile = await viewport.captureFourViews(state.forgeMesh.bbox);
      if (viewFile) {
        const shrunk = await shrinkPhotoForForge(viewFile);
        photoBase64 = shrunk.base64;
      }
    }

    const photoName =
      photoBlob && 'name' in photoBlob && typeof photoBlob.name === 'string'
        ? photoBlob.name.replace(/\.\w+$/, '')
        : '';
    const derivedName = (
      brief
        ? brief.slice(0, META.name)
        : photoName
          ? photoName.slice(0, META.name)
          : state.project.name &&
              state.project.name !== SAMPLE_LIST.name &&
              state.project.name !== state.forgeMesh?.name
            ? state.project.name
            : 'blender-cad-model'
    ).slice(0, META.name);
    state.project.name = derivedName;
    if ($('projectName')) $('projectName').value = derivedName;

    const preferredProvider =
      /** @type {HTMLSelectElement | null} */ ($('cadProviderSelect'))?.value || 'auto';

    setBusy(
      true,
      isRevision
        ? `1/2 Refining Blender 4.3 CAD Python (bpy) script [${preferredProvider}]...`
        : `1/2 Writing razor-sharp Blender 4.3 CAD Python (bpy) script [${preferredProvider}]...`,
    );
    addChat(
      'user',
      isRevision
        ? `Refine Blender 3D CAD [${preferredProvider}]: ${userFeedback || 'Add finer hard-surface details & greebles'}`
        : `Blender 3D CAD (${targetMm} mm, ${preferredProvider}): ${brief || '(from reference photo)'}${photoBlob ? ' [+photo]' : ''}`,
    );

    const autoPayloadB64 = btoa(
      unescape(
        encodeURIComponent(
          JSON.stringify({
            brief,
            scaleRef: state.project.scaleRef,
            previousCode: isRevision ? state.lastBlenderCode : '',
            userFeedback,
            photoBase64,
            preferredProvider,
          }),
        ),
      ),
    );

    const startRes = await caps.mcp.callTool(
      FORGE_SERVER,
      'forge_generate',
      {
        prompt: '__FORGE_BLENDER_AUTO__:cad',
        photoBase64: '__FORGE_BLENDER_AUTO__:' + autoPayloadB64,
        targetMm,
        name: derivedName,
      },
      { cache: false },
    );
    if (!startRes?.payload?.ok) {
      showError(startRes?.payload?.error || 'Blender CAD generation on AlienPC failed.');
      await refreshForgeStatus();
      return;
    }
    const out = await pollForgeJobUntilDone(startRes.payload.jobId, controller);
    if (!out) return;
    if (out.qualityMetrics?.pythonCode) {
      state.lastBlenderCode = out.qualityMetrics.pythonCode;
      $('rawReply').textContent = out.qualityMetrics.pythonCode;
    }
    const providerTag = out.qualityMetrics?.cadProvider
      ? ` [${out.qualityMetrics.cadProvider}]`
      : '';
    addChat(
      'claude',
      `Blender 4.3 Exact CAD ready${providerTag}: ${(out.qualityMetrics?.stl_faces || out.triangleCount).toLocaleString()} razor-sharp CAD triangles (${out.bbox.size.map((x) => x.toFixed(1)).join(' x ')} mm). Written to AlienPC: ${out.stlPath}`,
    );
    await refreshForgeStatus();
  } catch (e) {
    if (!controller.signal.aborted) {
      showError(`Blender error: ${e?.message || e?.code || 'failed'}`);
    }
  } finally {
    state.inference = null;
    setBusy(false, '');
  }
}

// ---------- Claude ----------
async function runInference(kind, requestText) {
  if (!caps.sample || state.inference) return;
  metaChange();
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
    name = state.forgeMesh ? state.project.name : list.name,
    slug = slugify(name);
  let data, filename;
  if (kind === 'zip') {
    const zip = new JSZip();
    zip.file(
      `${slug}.stl`,
      writeBinaryStl(concatTriangles(state.items.map((it) => it.tris)), name),
    );
    if (!state.forgeMesh) {
      zip.file(`${slug}.json`, JSON.stringify(list, null, 2));
    }
    zip.file(
      'README.txt',
      readmeText({
        list: state.forgeMesh
          ? {
              ...list,
              name,
              print: {
                ...list.print,
                orientation: `${state.meshTransform.tiltDeg} deg tilt, ${state.meshTransform.rotZDeg} deg Z (${state.items.length} part${state.items.length === 1 ? '' : 's'} nested)`,
              },
              assumptions: [
                `Generated by ShapeCast Studio v${UI_VERSION} (${state.forgeMesh.triangleCount} triangles per unit)`,
                `Nested build-plate count: ${state.items.length} part(s)`,
                `Peak FEP peel cross-section: ${Math.round(state.peelProfile.peakMm2)} mm^2 (${state.peelProfile.riskLevel} suction risk)`,
              ],
            }
          : list,
        result: state.result,
        layerUm: state.layerUm,
      }),
    );
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
  resetMeshTransformUi();
  state.forgeMesh = null;
  state.lastBlenderCode = null;
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
  const modeSel = /** @type {HTMLSelectElement} */ ($('modeSelect'));
  if (modeSel) {
    modeSel.addEventListener('change', () => setMode(modeSel.value));
  }
  $('modeBtnForge')?.addEventListener('click', () => setMode('forge'));
  $('modeBtnBlender')?.addEventListener('click', () => setMode('blender'));
  $('modeBtnBlocks')?.addEventListener('click', () => setMode('blocks'));
  $('cadPresetSelect')?.addEventListener('change', (e) => {
    const key = /** @type {HTMLSelectElement} */ (e.target).value;
    const preset = CAD_PRESETS[key];
    state.lastBlenderCode = null;
    if (preset) {
      state.project.name = preset.name;
      state.project.scaleRef = preset.scaleRef;
      state.project.brief = preset.brief;
      $('projectName').value = preset.name;
      $('scaleRef').value = preset.scaleRef;
      $('brief').value = preset.brief;
      metaChange();
    } else {
      state.project.brief = '';
      $('brief').value = '';
      metaChange();
    }
  });
  $('photoInput').addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const all = [...input.files];
    const stls = all.filter((f) => /\.stl$/i.test(f.name));
    const imgs = all.filter((f) => !/\.stl$/i.test(f.name));
    if (stls.length) importLocalStlFiles(stls);
    if (imgs.length) addPhotos(imgs);
    input.value = '';
  });
  $('stlInput')?.addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    importLocalStlFiles([...input.files]);
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
    const dropped = [...e.dataTransfer.files];
    const stls = dropped.filter((f) => /\.stl$/i.test(f.name));
    const imgs = dropped.filter((f) => f.type.startsWith('image/'));
    if (stls.length) importLocalStlFiles(stls);
    if (imgs.length) addPhotos(imgs);
  });
  for (const id of ['projectName', 'brief', 'scaleRef'])
    $(id).addEventListener('change', metaChange);
  $('buildBtn').addEventListener('click', () =>
    state.mode === 'forge'
      ? runForgeGenerate()
      : state.mode === 'blender'
        ? runBlenderGenerate()
        : runInference('build'),
  );
  $('refineBtn')?.addEventListener('click', () =>
    state.mode === 'blender'
      ? runBlenderGenerate('Inspect current CAD mesh and add finer hard-surface details & greebles')
      : runCriticRefineLoop(''),
  );
  $('sendBtn').addEventListener('click', () => {
    const box = /** @type {HTMLInputElement} */ ($('chatInput'));
    const t = box.value.trim();
    if (!t) return;
    box.value = '';
    if (state.mode === 'blender') {
      runBlenderGenerate(t);
    } else if (state.forgeMesh || state.mode === 'forge') {
      runCriticRefineLoop(t);
    } else {
      runInference('edit', t);
    }
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

  // Theme switcher (Optical Darkroom <-> Daylight Studio)
  const applyThemeUi = (theme) => {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    if ($('themeBtn')) {
      $('themeBtn').textContent = t === 'light' ? '\u263E Darkroom' : '\u2600 Light';
    }
    viewport?.setTheme();
  };
  try {
    const savedTheme = localStorage.getItem('shapecast.theme');
    if (savedTheme === 'light' || savedTheme === 'dark') applyThemeUi(savedTheme);
  } catch {
    /* ignore */
  }
  $('themeBtn')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyThemeUi(next);
    try {
      localStorage.setItem('shapecast.theme', next);
    } catch {
      /* ignore */
    }
  });

  // Showroom turntable
  $('spinBtn')?.addEventListener('click', () => {
    state.turntable = Boolean(viewport?.setTurntable(!state.turntable));
    $('spinBtn')?.classList.toggle('active', state.turntable);
  });

  // Real-time PBR Photopolymer Resin Shaders & Support Overhang Radar
  $('shaderBar')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button[data-shader]');
    if (!btn) return;
    const mode = btn.getAttribute('data-shader') || 'clay';
    viewport?.setShaderMode(mode);
    $('shaderBar')
      ?.querySelectorAll('button[data-shader]')
      .forEach((b) => b.classList.toggle('active', b === btn));
    updateTelemetryCards();
  });

  // 405nm UV Z-Layer X-Ray Scrubber & Animated Curing Sweep
  $('uvSliceRange')?.addEventListener('input', () => {
    stopUvScanAnim();
    updateUvSliceHud();
  });
  $('uvScanBtn')?.addEventListener('click', () => {
    if (state.uvScanAnim) {
      stopUvScanAnim();
      return;
    }
    const slider = /** @type {HTMLInputElement | null} */ ($('uvSliceRange'));
    const btn = $('uvScanBtn');
    if (!slider || !btn) return;
    btn.classList.add('active');
    btn.textContent = '\u23F8 Pause Scan';
    const startTs = performance.now();
    const durationMs = 4200;
    const step = (now) => {
      const p = Math.min(1, (now - startTs) / durationMs);
      slider.value = String(Math.round(25 + p * 975));
      updateUvSliceHud();
      if (p < 1) {
        state.uvScanAnim = requestAnimationFrame(step);
      } else {
        stopUvScanAnim();
      }
    };
    state.uvScanAnim = requestAnimationFrame(step);
  });

  // 1-Click Scale Presets (updates scaleRef + live-rescales loaded Forge/Blender mesh)
  $('quickScaleRow')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button[data-scale-mm]');
    if (!btn) return;
    const mm = Number(btn.getAttribute('data-scale-mm'));
    if (!(mm > 0)) return;
    $('scaleRef').value = `${mm} mm longest side`;
    metaChange();
    $('quickScaleRow')
      ?.querySelectorAll('button[data-scale-mm]')
      .forEach((b) => b.classList.toggle('active', b === btn));
    if (state.forgeMesh) {
      state.meshTransform.targetMm = mm;
      render();
      viewport?.fit(state.result?.bbox);
    }
  });

  // 1-Click Starter Briefs (zero-friction onboarding across Blender CAD & Hunyuan3D Sculpt)
  $('starterPromptRow')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button[data-starter]');
    if (!btn) return;
    const key = btn.getAttribute('data-starter') || '';
    const starter = STARTER_BRIEFS[key];
    if (!starter) return;
    state.lastBlenderCode = null;
    setMode(starter.mode);
    const cadSel = /** @type {HTMLSelectElement | null} */ ($('cadPresetSelect'));
    if (cadSel) cadSel.value = starter.presetKey || '';
    state.project.name = starter.name;
    state.project.scaleRef = starter.scaleRef;
    state.project.brief = starter.brief;
    $('projectName').value = starter.name;
    $('scaleRef').value = starter.scaleRef;
    $('brief').value = starter.brief;
    metaChange();
    $('starterPromptRow')
      ?.querySelectorAll('button[data-starter]')
      .forEach((b) => b.classList.toggle('active', b === btn));
    $('quickScaleRow')
      ?.querySelectorAll('button[data-scale-mm]')
      .forEach((b) =>
        b.classList.toggle('active', Number(b.getAttribute('data-scale-mm')) === starter.scaleMm),
      );
  });

  // Non-Destructive Build-Plate Orientation & Squadron Auto-Nesting Deck (exports directly into STL)
  $('orientDeck')?.addEventListener('click', (e) => {
    const tiltBtn = /** @type {HTMLElement} */ (e.target).closest('button[data-tilt]');
    if (tiltBtn && state.forgeMesh) {
      state.meshTransform.tiltDeg = Number(tiltBtn.getAttribute('data-tilt') || 0);
      $('orientDeck')
        ?.querySelectorAll('button[data-tilt]')
        .forEach((b) => b.classList.toggle('active', b === tiltBtn));
      render();
      viewport?.fit(state.result?.bbox);
      return;
    }
    const packBtn = /** @type {HTMLElement} */ (e.target).closest('button[data-pack]');
    if (packBtn && state.forgeMesh) {
      const val = packBtn.getAttribute('data-pack') || '1';
      if (val === 'max') {
        const rawTris = state.forgeMesh.rawTris || state.forgeMesh.tris;
        const primary = transformMeshTriangles(rawTris, state.meshTransform);
        const fit = maxCopiesOnSaturn3(primary.bbox || state.forgeMesh.bbox);
        if (fit.rotate90 && fit.count > state.packCount) {
          state.meshTransform.rotZDeg = (state.meshTransform.rotZDeg + 90) % 360;
          $('rotZ90Btn')?.classList.toggle('active', state.meshTransform.rotZDeg !== 0);
        }
        state.packCount = fit.count;
      } else {
        state.packCount = Math.max(1, Number(val) || 1);
      }
      $('platePackRow')
        ?.querySelectorAll('button[data-pack]')
        .forEach((b) => b.classList.toggle('active', b === packBtn));
      render();
      viewport?.fit(state.result?.bbox);
    }
  });
  $('clearExtraBtn')?.addEventListener('click', () => {
    state.extraPlateMeshes = [];
    render();
    viewport?.fit(state.result?.bbox);
  });
  $('rotZ90Btn')?.addEventListener('click', () => {
    if (!state.forgeMesh) return;
    state.meshTransform.rotZDeg = (state.meshTransform.rotZDeg + 90) % 360;
    $('rotZ90Btn')?.classList.toggle('active', state.meshTransform.rotZDeg !== 0);
    render();
    viewport?.fit(state.result?.bbox);
  });

  // Forge Vault Ribbon interactions (1-click solo load or +Plate multi-part compose)
  $('vaultList')?.addEventListener('click', (e) => {
    const loadBtn = /** @type {HTMLElement} */ (e.target).closest('button[data-vault-load]');
    if (loadBtn) {
      loadVaultStl(loadBtn.getAttribute('data-vault-load') || '', { addToPlate: false });
      return;
    }
    const addBtn = /** @type {HTMLElement} */ (e.target).closest('button[data-vault-add]');
    if (addBtn) {
      loadVaultStl(addBtn.getAttribute('data-vault-add') || '', { addToPlate: true });
    }
  });

  // Interactive FEP Peel-Stress Sparkline scrubbing
  const sparkEl = /** @type {HTMLCanvasElement | null} */ ($('peelSparkline'));
  const scrubSpark = (clientX) => {
    if (!sparkEl) return;
    const rect = sparkEl.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const ratio = Math.max(0.01, Math.min(1, (clientX - rect.left) / rect.width));
    const slider = /** @type {HTMLInputElement | null} */ ($('uvSliceRange'));
    if (slider) {
      stopUvScanAnim();
      slider.value = String(Math.round(ratio * 1000));
      updateUvSliceHud();
    }
  };
  let sparkDown = false;
  sparkEl?.addEventListener('pointerdown', (e) => {
    sparkDown = true;
    sparkEl.setPointerCapture(e.pointerId);
    scrubSpark(e.clientX);
  });
  sparkEl?.addEventListener('pointermove', (e) => {
    if (sparkDown) scrubSpark(e.clientX);
  });
  sparkEl?.addEventListener('pointerup', () => {
    sparkDown = false;
  });
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
  if (!caps.mcp) {
    caps.mcp = createLanMcpAdapter();
  }
  if (!caps.sample) {
    caps.sample = createLanSampleAdapter();
  }
  if (!caps.downloads) {
    caps.downloads = createBrowserDownloadsAdapter();
  }
  if (caps.mcp) {
    await refreshForgeStatus();
    setMode(state.mode);
  } else if (modeSel) {
    state.mode = 'blocks';
    modeSel.value = 'blocks';
    await refreshForgeStatus();
  }
  if (caps.sample) {
    const lim = await caps.sample.limits().catch(() => null);
    imageLimits = lim?.images ?? null;
    if (!imageLimits && state.mode === 'blocks')
      note('Photos cannot be sent to Claude from this artifact yet; the brief alone is used.');
    else if (imageLimits)
      /** @type {HTMLInputElement} */ ($('photoInput')).accept =
        imageLimits.mediaTypes.join(',') + ',.stl';
    setBusy(false, '');
  } else {
    setBusy(
      false,
      caps.mcp
        ? ''
        : 'Claude and Mesh Forge are unavailable in this view; you can still edit and export.',
    );
  }
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
    if (!caps.mcp?.isLanDirect) {
      $('localBanner').classList.remove('hidden');
    } else if ($('saveState')) {
      $('saveState').textContent = 'LAN Direct (OAuth)';
    }
    saveCtl?.dispose();
    saveCtl = makeSaveCtl(state.project);
    if (caps.mcp?.isLanDirect && $('saveState')) {
      $('saveState').textContent = 'LAN Direct (OAuth)';
    }
  }
  if (caps.mcp) {
    refreshVaultList();
    await restoreLatestForgeMeshIfAvailable();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        restoreLatestForgeMeshIfAvailable({ onlyActive: true });
        refreshVaultList();
      }
    });
  } else {
    renderVaultStrip();
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
