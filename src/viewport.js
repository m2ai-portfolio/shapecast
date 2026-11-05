import { SATURN3 } from './printcheck.js';

const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

const RESIN_PRESETS = {
  clay: {
    baseHex: 0xb4bcc8,
    roughness: 0.44,
    metalness: 0.06,
    clearcoat: 0.08,
    clearcoatRoughness: 0.45,
    opacity: 1.0,
    transparent: false,
  },
  aqua8k: {
    baseHex: 0x5d8aa8,
    roughness: 0.22,
    metalness: 0.08,
    clearcoat: 0.68,
    clearcoatRoughness: 0.16,
    opacity: 1.0,
    transparent: false,
  },
  emerald: {
    baseHex: 0x10b981,
    roughness: 0.12,
    metalness: 0.02,
    clearcoat: 0.92,
    clearcoatRoughness: 0.08,
    opacity: 0.84,
    transparent: true,
  },
  obsidian: {
    baseHex: 0x2a2f3a,
    roughness: 0.32,
    metalness: 0.22,
    clearcoat: 0.38,
    clearcoatRoughness: 0.24,
    opacity: 1.0,
    transparent: false,
  },
  overhang: {
    baseHex: 0x7b8494,
    roughness: 0.42,
    metalness: 0.04,
    clearcoat: 0.05,
    clearcoatRoughness: 0.5,
    opacity: 1.0,
    transparent: false,
  },
};

/**
 * Compute crease-angle vertex normals, Ridge/Valley curvature cavity vertex colors,
 * AND exact MSLA <45-deg overhang surface area statistics in one pass.
 */
function computeCreaseNormalsAndCavity(
  pos,
  baseColorHex,
  { cosCrease = 0.8829, shaderMode = 'clay' } = {},
) {
  const nTris = pos.length / 9;
  const faceNormals = new Float32Array(nTris * 3);
  const centroids = new Float32Array(nTris * 3);
  const vertMap = new Map();

  let totalMm2 = 0;
  let overhangMm2 = 0;

  for (let t = 0; t < nTris; t++) {
    const o = t * 9;
    const ax = pos[o],
      ay = pos[o + 1],
      az = pos[o + 2];
    const bx = pos[o + 3],
      by = pos[o + 4],
      bz = pos[o + 5];
    const cx = pos[o + 6],
      cy = pos[o + 7],
      cz = pos[o + 8];
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const crossLen = Math.hypot(nx, ny, nz);
    const area = crossLen * 0.5;
    const len = crossLen || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const fn = t * 3;
    faceNormals[fn] = nx;
    faceNormals[fn + 1] = ny;
    faceNormals[fn + 2] = nz;
    const czAvg = (az + bz + cz) * 0.3333333;
    centroids[fn] = (ax + bx + cx) * 0.3333333;
    centroids[fn + 1] = (ay + by + cy) * 0.3333333;
    centroids[fn + 2] = czAvg;

    totalMm2 += area;
    // Downward-facing surfaces above build plate (z > 0.25 mm) steeper than 45 deg (nz < -0.707) need supports
    if (czAvg > 0.25 && nz < -0.68) {
      overhangMm2 += area;
    }

    for (let k = 0; k < 3; k++) {
      const vo = o + k * 3;
      const key = `${Math.round(pos[vo] * 200)},${Math.round(pos[vo + 1] * 200)},${Math.round(pos[vo + 2] * 200)}`;
      let list = vertMap.get(key);
      if (!list) {
        list = [];
        vertMap.set(key, list);
      }
      list.push(t);
    }
  }

  const br = ((baseColorHex >> 16) & 255) / 255;
  const bg = ((baseColorHex >> 8) & 255) / 255;
  const bb = (baseColorHex & 255) / 255;
  const ridgeBoost = shaderMode === 'obsidian' ? 0.85 : 0.42;

  const normals = new Float32Array(pos.length);
  const colors = new Float32Array(pos.length);
  for (let t = 0; t < nTris; t++) {
    const o = t * 9;
    const fn = t * 3;
    const tnx = faceNormals[fn],
      tny = faceNormals[fn + 1],
      tnz = faceNormals[fn + 2];
    const tcx = centroids[fn],
      tcy = centroids[fn + 1],
      tcz = centroids[fn + 2];
    for (let k = 0; k < 3; k++) {
      const vo = o + k * 3;
      const vz = pos[vo + 2];
      const key = `${Math.round(pos[vo] * 200)},${Math.round(pos[vo + 1] * 200)},${Math.round(vz * 200)}`;
      const adj = vertMap.get(key);
      let sx = 0,
        sy = 0,
        sz = 0,
        curvSum = 0,
        curvCnt = 0;
      if (adj && adj.length > 1 && adj.length <= 28) {
        for (let i = 0; i < adj.length; i++) {
          const u = adj[i];
          const ofn = u * 3;
          const onx = faceNormals[ofn],
            ony = faceNormals[ofn + 1],
            onz = faceNormals[ofn + 2];
          const dot = tnx * onx + tny * ony + tnz * onz;
          if (dot >= cosCrease) {
            sx += onx;
            sy += ony;
            sz += onz;
          }
          if (u !== t && dot < 0.999) {
            const dx = centroids[ofn] - tcx,
              dy = centroids[ofn + 1] - tcy,
              dz = centroids[ofn + 2] - tcz;
            const dl = Math.hypot(dx, dy, dz);
            if (dl > 1e-5) {
              const bend = (dx * tnx + dy * tny + dz * tnz) / dl;
              const weight = Math.min(1.0, Math.sqrt(Math.max(0, 1 - dot)));
              curvSum += bend * weight;
              curvCnt++;
            }
          }
        }
      } else {
        sx = tnx;
        sy = tny;
        sz = tnz;
      }
      const sl = Math.hypot(sx, sy, sz) || 1;
      normals[vo] = sx / sl;
      normals[vo + 1] = sy / sl;
      normals[vo + 2] = sz / sl;

      let shade = 1.0;
      if (curvCnt > 0) {
        const avgCurv = curvSum / curvCnt;
        if (avgCurv > 0.01) {
          shade = Math.max(0.48, 1.0 - avgCurv * 1.38);
        } else if (avgCurv < -0.01) {
          shade = Math.min(1.28, 1.0 - avgCurv * ridgeBoost);
        }
      }

      if (shaderMode === 'overhang') {
        if (vz <= 0.22 && tnz < -0.5) {
          // Grounded directly on Saturn 3 build plate -> emerald safe contact
          colors[vo] = Math.min(1, 0.14 * shade);
          colors[vo + 1] = Math.min(1, 0.78 * shade);
          colors[vo + 2] = Math.min(1, 0.42 * shade);
        } else if (vz > 0.22 && tnz < -0.7) {
          // Critical overhang / island (<45 deg) -> crimson support alert
          colors[vo] = Math.min(1, 0.96 * shade);
          colors[vo + 1] = Math.min(1, 0.22 * shade);
          colors[vo + 2] = Math.min(1, 0.24 * shade);
        } else if (vz > 0.22 && tnz < -0.42) {
          // Marginal overhang (45-65 deg) -> warm amber caution
          colors[vo] = Math.min(1, 0.96 * shade);
          colors[vo + 1] = Math.min(1, 0.64 * shade);
          colors[vo + 2] = Math.min(1, 0.12 * shade);
        } else {
          // Self-supporting wall / upward surface
          colors[vo] = Math.min(1, br * shade);
          colors[vo + 1] = Math.min(1, bg * shade);
          colors[vo + 2] = Math.min(1, bb * shade);
        }
      } else {
        colors[vo] = Math.min(1, br * shade);
        colors[vo + 1] = Math.min(1, bg * shade);
        colors[vo + 2] = Math.min(1, bb * shade);
      }
    }
  }
  return { normals, colors, totalMm2, overhangMm2 };
}

/** Three.js viewport with a true-size Saturn 3 plate, 405nm UV X-Ray Slicer, and Resin Shaders. */
export function createViewport(canvas, { onSelect = (_id) => {} } = {}) {
  if (typeof THREE === 'undefined') return null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.localClippingEnabled = true;
  if (THREE.ACESFilmicToneMapping !== undefined) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 6000);
  camera.up.set(0, 0, 1);
  const target = new THREE.Vector3(0, 0, 30);
  let theta = -0.92,
    phi = 1.06,
    dist = 420,
    needsRender = true,
    turntable = false,
    shaderMode = 'clay',
    sliceRatio = 1.0,
    sliceMaxZ = 100,
    cachedItems = [],
    cachedSelectedId = null,
    overhangStats = { overhangPct: 0, overhangMm2: 0, totalMm2: 0 };

  // 4-point optical darkroom studio rig
  scene.add(new THREE.HemisphereLight(0xf4f7ff, 0x14171f, 0.42));
  const keyLight = new THREE.DirectionalLight(0xfffcf5, 1.38);
  keyLight.position.set(220, -280, 390);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0xa5b4fc, 0.68);
  rimLight.position.set(-260, 250, 240);
  scene.add(rimLight);
  const fillLight = new THREE.DirectionalLight(0xe0f2fe, 0.34);
  fillLight.position.set(-220, -180, 110);
  scene.add(fillLight);

  const [W, D, H] = SATURN3.build;
  const plateMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.34,
    side: THREE.DoubleSide,
  });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(W, D), plateMat);
  plate.position.z = -0.04;
  scene.add(plate);

  // Minor 10mm + Major 50mm reticle grid
  const minorPts = [];
  const majorPts = [];
  for (let x = -W / 2; x <= W / 2 + 1e-6; x += 10) {
    const bucket = Math.abs(Math.round(x) % 50) === 0 ? majorPts : minorPts;
    bucket.push(x, -D / 2, 0, x, D / 2, 0);
  }
  for (let y = -D / 2; y <= D / 2 + 1e-6; y += 10) {
    const bucket = Math.abs(Math.round(y) % 50) === 0 ? majorPts : minorPts;
    bucket.push(-W / 2, y, 0, W / 2, y, 0);
  }
  const minorGeo = new THREE.BufferGeometry();
  minorGeo.setAttribute('position', new THREE.Float32BufferAttribute(minorPts, 3));
  const gridMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.28 });
  scene.add(new THREE.LineSegments(minorGeo, gridMat));

  const majorGeo = new THREE.BufferGeometry();
  majorGeo.setAttribute('position', new THREE.Float32BufferAttribute(majorPts, 3));
  const majorMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.58 });
  scene.add(new THREE.LineSegments(majorGeo, majorMat));

  // Front build-plate orientation bar (Saturn 3 vat front edge)
  const frontBarGeo = new THREE.BufferGeometry();
  frontBarGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-W * 0.28, -D / 2, 0.06, W * 0.28, -D / 2, 0.06], 3),
  );
  const frontBarMat = new THREE.LineBasicMaterial({
    color: 0xf59e0b,
    transparent: true,
    opacity: 0.85,
  });
  scene.add(new THREE.LineSegments(frontBarGeo, frontBarMat));

  const ghostMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.22 });
  const ghost = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D, H)),
    ghostMat,
  );
  ghost.position.z = H / 2;
  scene.add(ghost);

  // 405nm UV Laser Slicer Clipping Plane & Optical LCD Plane
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6);
  const uvLaserGroup = new THREE.Group();
  uvLaserGroup.visible = false;
  const uvPlaneMat = new THREE.MeshBasicMaterial({
    color: 0xa855f7,
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const uvPlaneMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, D), uvPlaneMat);
  uvLaserGroup.add(uvPlaneMesh);
  const uvBorderEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, D)),
    new THREE.LineBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.92 }),
  );
  uvLaserGroup.add(uvBorderEdges);
  scene.add(uvLaserGroup);

  const group = new THREE.Group();
  const capGroup = new THREE.Group();
  scene.add(group);
  scene.add(capGroup);

  const colors = { base: 0xb4bcc8, accent: 0xf59e0b, failed: 0xef4444 };
  function setTheme() {
    const hex = (v) => parseInt(v.replace('#', ''), 16);
    plateMat.color.setHex(hex(cssVar('--plate', '#252932')));
    gridMat.color.setHex(hex(cssVar('--grid', '#4b5262')));
    majorMat.color.setHex(hex(cssVar('--grid-major', '#6b7488')));
    ghostMat.color.setHex(hex(cssVar('--grid', '#4b5262')));
    colors.base = hex(cssVar('--part', '#b4bcc8'));
    colors.accent = hex(cssVar('--accent', '#f59e0b'));
    colors.failed = hex(cssVar('--red', '#ef4444'));
    needsRender = true;
  }

  function clearGroup(g) {
    for (const m of [...g.children]) {
      g.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
  }

  function updateSliceVisuals() {
    if (sliceRatio >= 0.999) {
      clipPlane.constant = 1e6;
      uvLaserGroup.visible = false;
      capGroup.visible = false;
    } else {
      const zCut = Math.max(0.05, sliceRatio * Math.max(0.5, sliceMaxZ));
      clipPlane.constant = zCut;
      uvLaserGroup.position.z = zCut;
      uvLaserGroup.visible = true;
      capGroup.visible = true;
    }
    needsRender = true;
  }

  function rebuildMeshes() {
    clearGroup(group);
    clearGroup(capGroup);
    const preset = RESIN_PRESETS[shaderMode] || RESIN_PRESETS.clay;
    let sumTotal = 0,
      sumOverhang = 0,
      maxZ = 1;

    for (const it of cachedItems) {
      if (it.bbox?.max?.[2] > maxZ) maxZ = it.bbox.max[2];
      const geo = new THREE.BufferGeometry();
      const posArr = Float32Array.from(it.tris);
      const baseHex = it.failed
        ? colors.failed
        : it.part.id === cachedSelectedId
          ? colors.accent
          : shaderMode === 'clay'
            ? colors.base
            : preset.baseHex;
      const {
        normals,
        colors: vColors,
        totalMm2,
        overhangMm2,
      } = computeCreaseNormalsAndCavity(posArr, baseHex, { shaderMode });
      sumTotal += totalMm2;
      sumOverhang += overhangMm2;

      geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(vColors, 3));

      const MatCtor = THREE.MeshPhysicalMaterial || THREE.MeshStandardMaterial;
      const matOpts = {
        color: 0xffffff,
        vertexColors: true,
        roughness: preset.roughness,
        metalness: preset.metalness,
        transparent: preset.transparent,
        opacity: preset.opacity,
        clippingPlanes: [clipPlane],
        clipShadows: true,
      };
      if (THREE.MeshPhysicalMaterial) {
        matOpts.clearcoat = preset.clearcoat;
        matOpts.clearcoatRoughness = preset.clearcoatRoughness;
      }
      const mesh = new THREE.Mesh(geo, new MatCtor(matOpts));
      mesh.userData.id = it.part.id;
      group.add(mesh);

      // 405nm UV glowing interior cross-section cap when Z-slicer clips the watertight solid
      const capMesh = new THREE.Mesh(
        geo.clone(),
        new THREE.MeshBasicMaterial({
          color: 0xb453f8,
          side: THREE.BackSide,
          clippingPlanes: [clipPlane],
        }),
      );
      capGroup.add(capMesh);
    }

    sliceMaxZ = maxZ;
    overhangStats = {
      overhangPct: sumTotal > 0 ? (sumOverhang / sumTotal) * 100 : 0,
      overhangMm2: sumOverhang,
      totalMm2: sumTotal,
    };
    updateSliceVisuals();
    needsRender = true;
  }

  function setItems(items, selectedId) {
    cachedItems = items || [];
    cachedSelectedId = selectedId;
    rebuildMeshes();
  }

  function setShaderMode(mode) {
    if (!RESIN_PRESETS[mode] || mode === shaderMode) return overhangStats;
    shaderMode = mode;
    rebuildMeshes();
    return overhangStats;
  }

  function setSliceRatio(ratio, explicitMaxZ) {
    sliceRatio = Math.max(0, Math.min(1, Number(ratio)));
    if (explicitMaxZ && explicitMaxZ > 0) sliceMaxZ = explicitMaxZ;
    updateSliceVisuals();
  }

  function setTurntable(enabled) {
    turntable = Boolean(enabled);
    if (turntable) needsRender = true;
    return turntable;
  }

  function getOverhangStats() {
    return overhangStats;
  }

  function updateCamera() {
    camera.position.set(
      target.x + dist * Math.sin(phi) * Math.cos(theta),
      target.y + dist * Math.sin(phi) * Math.sin(theta),
      target.z + dist * Math.cos(phi),
    );
    camera.lookAt(target);
    const kPhi = Math.max(0.18, phi - 0.42),
      kTheta = theta + 0.58;
    keyLight.position.set(
      target.x + 480 * Math.sin(kPhi) * Math.cos(kTheta),
      target.y + 480 * Math.sin(kPhi) * Math.sin(kTheta),
      target.z + 480 * Math.cos(kPhi),
    );
    const rPhi = Math.max(0.22, phi - 0.35),
      rTheta = theta - 2.15;
    rimLight.position.set(
      target.x + 480 * Math.sin(rPhi) * Math.cos(rTheta),
      target.y + 480 * Math.sin(rPhi) * Math.sin(rTheta),
      target.z + 480 * Math.cos(rPhi),
    );
    const fPhi = Math.min(2.7, phi + 0.28),
      fTheta = theta - 0.65;
    fillLight.position.set(
      target.x + 480 * Math.sin(fPhi) * Math.cos(fTheta),
      target.y + 480 * Math.sin(fPhi) * Math.sin(fTheta),
      target.z + 480 * Math.cos(fPhi),
    );
    needsRender = true;
  }

  function fit(bbox) {
    if (!bbox) return;
    target.set(
      (bbox.min[0] + bbox.max[0]) / 2,
      (bbox.min[1] + bbox.max[1]) / 2,
      (bbox.min[2] + bbox.max[2]) / 2,
    );
    dist = Math.max(...bbox.size) * 1.85 + 38;
    updateCamera();
  }

  function view(name) {
    if (name === 'top') {
      theta = -Math.PI / 2;
      phi = 0.001;
    } else if (name === 'front') {
      theta = -Math.PI / 2;
      phi = Math.PI / 2 - 0.001;
    } else {
      theta = -0.92;
      phi = 1.06;
    }
    updateCamera();
  }

  function resize() {
    const w = canvas.clientWidth || 300,
      h = canvas.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }

  let down = null,
    moved = false;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey };
    moved = false;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x,
      dy = e.clientY - down.y;
    down.x = e.clientX;
    down.y = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
    if (down.b === 0 && !down.shift) {
      theta -= dx * 0.006;
      phi = Math.min(Math.PI - 0.02, Math.max(0.02, phi - dy * 0.006));
    } else {
      const right = new THREE.Vector3()
        .crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up)
        .normalize();
      target.addScaledVector(right, -dx * dist * 0.0015);
      target.addScaledVector(camera.up, dy * dist * 0.0015);
    }
    updateCamera();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (down && !moved) {
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(group.children)[0];
      onSelect(hit ? hit.object.userData.id : null);
    }
    down = null;
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      dist = Math.min(4000, Math.max(20, dist * Math.exp(e.deltaY * 0.0012)));
      updateCamera();
    },
    { passive: false },
  );
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  new ResizeObserver(resize).observe(canvas.parentElement);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setTheme);

  let lastTs = performance.now();
  function loop(now = performance.now()) {
    const dt = Math.min(0.05, (now - lastTs) / 1000);
    lastTs = now;
    if (turntable && !down) {
      theta -= dt * 0.55;
      updateCamera();
    }
    if (needsRender) {
      renderer.render(scene, camera);
      needsRender = false;
    }
    requestAnimationFrame(loop);
  }

  async function captureFourViews(bbox) {
    try {
      const savedTheta = theta,
        savedPhi = phi,
        savedRatio = sliceRatio;
      setSliceRatio(1.0);
      if (bbox) fit(bbox);
      const out = document.createElement('canvas');
      out.width = 640;
      out.height = 640;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#111318';
      ctx.fillRect(0, 0, 640, 640);
      const angles = [
        { t: -0.92, p: 1.06, x: 0, y: 0, label: '3/4 ISO' },
        { t: -Math.PI / 2, p: Math.PI / 2 - 0.01, x: 320, y: 0, label: 'FRONT / SIDE' },
        { t: 0, p: Math.PI / 2 - 0.01, x: 0, y: 320, label: 'PROFILE' },
        { t: -Math.PI / 2, p: 0.01, x: 320, y: 320, label: 'TOP' },
      ];
      for (const a of angles) {
        theta = a.t;
        phi = a.p;
        updateCamera();
        renderer.render(scene, camera);
        ctx.drawImage(canvas, a.x, a.y, 320, 320);
        ctx.fillStyle = '#f59e0b';
        ctx.font = '12px sans-serif';
        ctx.fillText(a.label, a.x + 8, a.y + 18);
      }
      theta = savedTheta;
      phi = savedPhi;
      setSliceRatio(savedRatio);
      updateCamera();
      renderer.render(scene, camera);
      const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', 0.85));
      return blob ? new File([blob], 'mesh-4view.jpg', { type: 'image/jpeg' }) : null;
    } catch {
      return null;
    }
  }

  setTheme();
  resize();
  updateCamera();
  loop();
  return {
    setItems,
    fit,
    view,
    resize,
    setTheme,
    captureFourViews,
    setShaderMode,
    setSliceRatio,
    setTurntable,
    getOverhangStats,
  };
}
