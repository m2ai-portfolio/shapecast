import { SATURN3 } from './printcheck.js';

const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

/**
 * Compute crease-angle vertex normals on a non-indexed triangle position array:
 * - Smoothly blends normals across micro-facets where dihedral angle < creaseDeg (28 deg)
 * - Preserves razor-sharp hard edges on rafters, window frames, roof eaves & creases (>= 28 deg)
 */
function computeCreaseNormals(pos, cosCrease = 0.8829) {
  const nTris = pos.length / 9;
  const faceNormals = new Float32Array(nTris * 3);
  const vertMap = new Map();

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
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const fn = t * 3;
    faceNormals[fn] = nx;
    faceNormals[fn + 1] = ny;
    faceNormals[fn + 2] = nz;

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

  const normals = new Float32Array(pos.length);
  for (let t = 0; t < nTris; t++) {
    const o = t * 9;
    const fn = t * 3;
    const tnx = faceNormals[fn],
      tny = faceNormals[fn + 1],
      tnz = faceNormals[fn + 2];
    for (let k = 0; k < 3; k++) {
      const vo = o + k * 3;
      const key = `${Math.round(pos[vo] * 200)},${Math.round(pos[vo + 1] * 200)},${Math.round(pos[vo + 2] * 200)}`;
      const adj = vertMap.get(key);
      let sx = 0,
        sy = 0,
        sz = 0;
      if (adj && adj.length > 1 && adj.length <= 24) {
        for (let i = 0; i < adj.length; i++) {
          const ofn = adj[i] * 3;
          const onx = faceNormals[ofn],
            ony = faceNormals[ofn + 1],
            onz = faceNormals[ofn + 2];
          if (tnx * onx + tny * ony + tnz * onz >= cosCrease) {
            sx += onx;
            sy += ony;
            sz += onz;
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
    }
  }
  return normals;
}

/** Three.js viewport with a true-size Saturn 3 plate. Returns null when THREE or WebGL is missing. */
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
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
  camera.up.set(0, 0, 1);
  const target = new THREE.Vector3(0, 0, 30);
  let theta = -0.9,
    phi = 1.05,
    dist = 420,
    needsRender = true;
  // High-contrast 3-point studio clay lighting (matching Meshy crisp crevice shading)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x1e2024, 0.36));
  const keyLight = new THREE.DirectionalLight(0xfffdf8, 1.32);
  keyLight.position.set(220, -280, 390);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0xdce6ff, 0.55);
  rimLight.position.set(-260, 250, 240);
  scene.add(rimLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.28);
  fillLight.position.set(-220, -180, 110);
  scene.add(fillLight);

  const [W, D, H] = SATURN3.build;
  const plateMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
  });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(W, D), plateMat);
  plate.position.z = -0.02;
  scene.add(plate);
  const gridPts = [];
  for (let x = -W / 2; x <= W / 2 + 1e-6; x += 10) gridPts.push(x, -D / 2, 0, x, D / 2, 0);
  for (let y = -D / 2; y <= D / 2 + 1e-6; y += 10) gridPts.push(-W / 2, y, 0, W / 2, y, 0);
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  const gridMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 });
  scene.add(new THREE.LineSegments(gridGeo, gridMat));
  const ghostMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 });
  const ghost = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D, H)),
    ghostMat,
  );
  ghost.position.z = H / 2;
  scene.add(ghost);

  const group = new THREE.Group();
  scene.add(group);
  const colors = { base: 0x8a8f99, accent: 0xd98c1f, failed: 0xb3261e };
  function setTheme() {
    const hex = (v) => parseInt(v.replace('#', ''), 16);
    plateMat.color.setHex(hex(cssVar('--plate', '#9aa0a6')));
    gridMat.color.setHex(hex(cssVar('--grid', '#9aa0a6')));
    ghostMat.color.setHex(hex(cssVar('--grid', '#9aa0a6')));
    colors.base = hex(cssVar('--part', '#8a8f99'));
    colors.accent = hex(cssVar('--accent', '#d98c1f'));
    colors.failed = hex(cssVar('--red', '#b3261e'));
    needsRender = true;
  }
  function setItems(items, selectedId) {
    for (const m of [...group.children]) {
      group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    for (const it of items) {
      const geo = new THREE.BufferGeometry();
      const posArr = Float32Array.from(it.tris);
      geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(computeCreaseNormals(posArr), 3));
      const color = it.failed
        ? colors.failed
        : it.part.id === selectedId
          ? colors.accent
          : colors.base;
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color, roughness: 0.52, metalness: 0.04 }),
      );
      mesh.userData.id = it.part.id;
      group.add(mesh);
    }
    needsRender = true;
  }
  function updateCamera() {
    camera.position.set(
      target.x + dist * Math.sin(phi) * Math.cos(theta),
      target.y + dist * Math.sin(phi) * Math.sin(theta),
      target.z + dist * Math.cos(phi),
    );
    camera.lookAt(target);
    needsRender = true;
  }
  function fit(bbox) {
    if (!bbox) return;
    target.set(
      (bbox.min[0] + bbox.max[0]) / 2,
      (bbox.min[1] + bbox.max[1]) / 2,
      (bbox.min[2] + bbox.max[2]) / 2,
    );
    dist = Math.max(...bbox.size) * 1.9 + 40;
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
      theta = -0.9;
      phi = 1.05;
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
  function loop() {
    if (needsRender) {
      renderer.render(scene, camera);
      needsRender = false;
    }
    requestAnimationFrame(loop);
  }
  async function captureFourViews(bbox) {
    try {
      const savedTheta = theta,
        savedPhi = phi;
      if (bbox) fit(bbox);
      const out = document.createElement('canvas');
      out.width = 640;
      out.height = 640;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#17181a';
      ctx.fillRect(0, 0, 640, 640);
      const angles = [
        { t: -0.9, p: 1.05, x: 0, y: 0, label: '3/4 ISO' },
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
        ctx.fillStyle = '#e0912a';
        ctx.font = '12px sans-serif';
        ctx.fillText(a.label, a.x + 8, a.y + 18);
      }
      theta = savedTheta;
      phi = savedPhi;
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
  return { setItems, fit, view, resize, setTheme, captureFourViews };
}
