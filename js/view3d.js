/**
 * view3d.js — 2D 도면을 3D로 세워 보여주는 뷰어 + 3D 파일 내보내기
 *
 * 2D 캔버스가 1px = 1cm 정확 치수 모델이므로, 각 객체에 '높이'만 부여하면
 * 그대로 입체가 된다. three.js 좌표는 미터(m) 단위로 환산해 쓴다.
 *   도면 (x, y)  →  3D (x/100, 높이, y/100)
 *
 * 표현 범위: 외벽·바닥 · 부속실(벽 + 바닥) · 문 개구부 ·
 *            병상 모듈(침대·매트리스·베개·투석기) · 배관 콘솔 · N.S 카운터/데스크
 *
 * 내보내기: glTF(.glb) / OBJ — Blender·SketchUp+Enscape·Twinmotion 등에서
 * 재질·조명을 입혀 실사 렌더링할 수 있다.
 */
const View3D = (() => {
  const M = (cm) => cm / 100;           // cm → m
  const WALL_H = 2.7;                   // 실 벽 높이(m) — 천장고 기준
  const PARTITION_H = 2.4;              // 부속실 칸막이벽 높이(m)
  const DOOR_H = 2.1;                   // 문 개구부 높이(m)

  let renderer = null, scene = null, camera = null, controls = null;
  let overlay = null, canvasEl = null, raf = null, lastRoom = null;
  let bedBounds = null;   // 병상 필드 범위(cm) — 눈높이 카메라 기준점

  /* ───────── 재질 (실사 렌더러로 내보낼 때 그대로 매핑된다) ───────── */
  const MAT = {};
  function initMaterials() {
    const std = (color, opts = {}) =>
      new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.85, metalness: 0.02 }, opts));
    MAT.floor = std(0xdcd8d0, { roughness: 0.72 });
    MAT.wall = std(0xeceae5, { roughness: 0.95 });
    MAT.partition = std(0xdad7d0, { roughness: 0.95 });
    MAT.roomFloor = std(0xffffff, { roughness: 0.6 });
    MAT.bedFrame = std(0xcfd8dc, { roughness: 0.5, metalness: 0.35 });
    MAT.mattress = std(0x7cb87f, { roughness: 0.9 });
    MAT.pillow = std(0xffffff, { roughness: 0.95 });
    MAT.machine = std(0x2f6fb5, { roughness: 0.45 });
    MAT.screen = std(0x101418, { roughness: 0.25, metalness: 0.4 });
    MAT.console = std(0x78909c, { roughness: 0.7 });
    MAT.counter = std(0xd7a86a, { roughness: 0.6 });
    MAT.desk = std(0xe8a33d, { roughness: 0.6 });
    MAT.chair = std(0x455a64, { roughness: 0.7 });
    MAT.equip = std(0xb0bec5, { roughness: 0.7 });
  }

  /** 축 정렬 박스 추가: 도면 좌표(cm) + 바닥 기준 높이(m) */
  function box(group, x, y, w, d, h, mat, yBase = 0) {
    if (w <= 0 || d <= 0 || h <= 0) return null;
    const g = new THREE.Mesh(new THREE.BoxGeometry(M(w), h, M(d)), mat);
    g.position.set(M(x) + M(w) / 2, yBase + h / 2, M(y) + M(d) / 2);
    g.castShadow = true;
    g.receiveShadow = true;
    group.add(g);
    return g;
  }

  /**
   * 문 개구부를 반영해 한 면의 벽을 여러 조각으로 나눠 세운다.
   * horiz=true면 x 방향으로 뻗는 벽, false면 y 방향.
   * gaps: 벽을 따라가는 좌표(cm) 구간 배열 [[s,e], ...]
   */
  function wallWithGaps(group, x, y, len, thick, h, mat, horiz, gaps) {
    const segs = [];
    let cur = 0;
    [...gaps].sort((a, b) => a[0] - b[0]).forEach(([s, e]) => {
      const s2 = Math.max(0, s), e2 = Math.min(len, e);
      if (e2 <= s2) return;
      if (s2 > cur) segs.push([cur, s2]);
      cur = Math.max(cur, e2);
    });
    if (cur < len) segs.push([cur, len]);
    segs.forEach(([s, e]) => {
      if (horiz) box(group, x + s, y, e - s, thick, h, mat);
      else box(group, x, y + s, thick, e - s, h, mat);
    });
    // 개구부 위 인방(lintel) — 문 높이 위쪽은 벽이 이어진다
    if (h > DOOR_H) {
      gaps.forEach(([s, e]) => {
        const s2 = Math.max(0, s), e2 = Math.min(len, e);
        if (e2 <= s2) return;
        if (horiz) box(group, x + s2, y, e2 - s2, thick, h - DOOR_H, mat, DOOR_H);
        else box(group, x, y + s2, thick, e2 - s2, h - DOOR_H, mat, DOOR_H);
      });
    }
  }

  /** 2D 객체의 도면 좌표 사각형(cm) — 회전은 축 정렬 바운딩으로 근사 */
  function rectOf(o) {
    const r = o.getBoundingRect(true);
    return { x: r.left, y: r.top, w: r.width, d: r.height };
  }

  /** 병상 모듈: 침대(프레임+매트리스+베개) + 투석기 */
  function buildBedUnit(group, unit) {
    const m = unit.calcTransformMatrix();
    const at = (child) => {
      const p = fabric.util.transformPoint(child.getCenterPoint(), m);
      const w = child.width * (child.scaleX || 1) * (unit.scaleX || 1);
      const d = child.height * (child.scaleY || 1) * (unit.scaleY || 1);
      return { x: p.x - w / 2, y: p.y - d / 2, w, d };
    };
    unit.getObjects().forEach((c) => {
      const key = c.meta && c.meta.key;
      if (key === "dialysis_bed") {
        const b = at(c);
        box(group, b.x, b.y, b.w, b.d, 0.42, MAT.bedFrame);              // 프레임
        box(group, b.x + 4, b.y + 4, b.w - 8, b.d - 8, 0.16, MAT.mattress, 0.42); // 매트리스
        // 베개는 머리맡(콘솔) 쪽 끝에 놓는다 — 2D의 머리 방향을 그대로 따른다
        if (unit.meta.vertical) {   // 세로 배치: 머리맡이 좌/우
          const px = unit.meta.headLeft ? b.x + 6 : b.x + b.w - 40;
          box(group, px, b.y + 15, 34, b.d - 30, 0.1, MAT.pillow, 0.58);
        } else {                    // 가로 배치: 머리맡이 위/아래
          const py = unit.meta.headDown ? b.y + b.d - 40 : b.y + 6;
          box(group, b.x + 15, py, b.w - 30, 34, 0.1, MAT.pillow, 0.58);
        }
      } else if (key === "dialysis_machine") {
        const q = at(c);
        box(group, q.x, q.y, q.w, q.d, 1.05, MAT.machine);               // 본체
        // 조작 패널은 환자(침대) 쪽 면에 붙인다
        if (unit.meta.vertical) {
          const sx = unit.meta.headLeft ? q.x + q.w - 6 : q.x + 1;
          box(group, sx, q.y + 4, 5, q.d - 8, 0.34, MAT.screen, 1.05);
        } else {
          const sy = unit.meta.headDown ? q.y + 1 : q.y + q.d - 6;
          box(group, q.x + 4, sy, q.w - 8, 5, 0.34, MAT.screen, 1.05);
        }
      }
    });
  }

  /** N.S 카운터: 상부 바 + 좌우 팔 (출입 개구부 반영) */
  function buildStation(group, ns) {
    const r = rectOf(ns);
    const BAR = 40, ENTRY = MEDICAL_RULES.NS_ENTRY_CM, H = 1.1;
    box(group, r.x, r.y, r.w, BAR, H, MAT.counter);                  // 후면 카운터
    // 좌우 팔 — 출입 개구부(카운터 바로 아래 800mm)는 비운다
    [[r.x, "left"], [r.x + r.w - BAR, "right"]].forEach(([ax]) => {
      wallWithGaps(group, ax, r.y, r.d, BAR, H, MAT.counter, false,
        [[BAR, BAR + ENTRY]]);
    });
  }

  /* ───────── 장면 구성 ───────── */
  function buildScene() {
    const room = FloorCanvas.getRoom();
    const objs = FloorCanvas.getObjects();
    lastRoom = room;
    const root = new THREE.Group();

    // 바닥
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(M(room.width), M(room.height)), MAT.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(M(room.width) / 2, 0, M(room.height) / 2);
    floor.receiveShadow = true;
    root.add(floor);

    // 문 위치 수집 → 벽 개구부로 사용
    const doors = objs.filter((o) => o.meta.isDoor).map((o) => {
      const r = rectOf(o);
      return { cx: r.x + r.w / 2, cy: r.y + r.d / 2, w: Math.max(r.w, r.d) };
    });
    const WT = 10; // 외벽 두께(cm)
    /** 주어진 벽 선분 위에 놓인 문들을 [s,e] 구간(벽 시작점 기준)으로 변환 */
    const gapsOn = (x, y, len, horiz, tol = 40) => doors
      .filter((d) => (horiz ? Math.abs(d.cy - y) < tol : Math.abs(d.cx - x) < tol))
      .map((d) => {
        const p = (horiz ? d.cx - x : d.cy - y);
        return [p - d.w / 2 - 5, p + d.w / 2 + 5];
      })
      .filter(([s, e]) => e > 0 && s < len);

    // 외벽 4면
    wallWithGaps(root, 0, 0, room.width, WT, WALL_H, MAT.wall, true, gapsOn(0, 0, room.width, true));
    wallWithGaps(root, 0, room.height - WT, room.width, WT, WALL_H, MAT.wall, true,
      gapsOn(0, room.height, room.width, true));
    wallWithGaps(root, 0, 0, room.height, WT, WALL_H, MAT.wall, false, gapsOn(0, 0, room.height, false));
    wallWithGaps(root, room.width - WT, 0, room.height, WT, WALL_H, MAT.wall, false,
      gapsOn(room.width, 0, room.height, false));

    // 부속실: 바닥 + 4면 칸막이벽(문 개구부 반영)
    objs.filter((o) => ["room", "infrastructure"].includes(o.meta.type)
                       && o.meta.key !== "nurse_station").forEach((o) => {
      const r = rectOf(o);
      const t = 8; // 칸막이 두께(cm)
      const col = new THREE.Color(o.meta.color || "#e0e0e0");
      const fmat = MAT.roomFloor.clone();
      fmat.color = col.clone().lerp(new THREE.Color(0xffffff), 0.45);
      const f = new THREE.Mesh(new THREE.PlaneGeometry(M(r.w), M(r.d)), fmat);
      f.rotation.x = -Math.PI / 2;
      f.position.set(M(r.x) + M(r.w) / 2, 0.006, M(r.y) + M(r.d) / 2);
      f.receiveShadow = true;
      root.add(f);
      wallWithGaps(root, r.x, r.y, r.w, t, PARTITION_H, MAT.partition, true, gapsOn(r.x, r.y, r.w, true));
      wallWithGaps(root, r.x, r.y + r.d - t, r.w, t, PARTITION_H, MAT.partition, true,
        gapsOn(r.x, r.y + r.d, r.w, true));
      wallWithGaps(root, r.x, r.y, r.d, t, PARTITION_H, MAT.partition, false, gapsOn(r.x, r.y, r.d, false));
      wallWithGaps(root, r.x + r.w - t, r.y, r.d, t, PARTITION_H, MAT.partition, false,
        gapsOn(r.x + r.w, r.y, r.d, false));
    });

    // 배관 콘솔 (병상 머리맡 덕트)
    objs.filter((o) => o.meta.key === "bed_console").forEach((o) => {
      const r = rectOf(o);
      box(root, r.x, r.y, r.w, r.d, 0.95, MAT.console);
    });

    // 병상 모듈 (+ 눈높이 카메라가 볼 병상 필드 범위 기록)
    const units = objs.filter((o) => o.meta.key === "bed_unit");
    units.forEach((u) => buildBedUnit(root, u));
    bedBounds = units.length ? units.map(rectOf).reduce((a, r) => ({
      x0: Math.min(a.x0, r.x), x1: Math.max(a.x1, r.x + r.w),
      y0: Math.min(a.y0, r.y), y1: Math.max(a.y1, r.y + r.d),
    }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }) : null;

    // N.S 카운터 + 데스크·의자
    const ns = objs.find((o) => o.meta.key === "nurse_station");
    if (ns) buildStation(root, ns);
    objs.filter((o) => o.meta.key === "station_desk2").forEach((o) => {
      const r = rectOf(o);
      box(root, r.x, r.y + r.d * 0.42, r.w, r.d * 0.58, 0.75, MAT.desk); // 상판
      [0.25, 0.72].forEach((f) => // 의자 2개 (뒤쪽 = 카운터 쪽)
        box(root, r.x + r.w * f - 18, r.y + 4, 36, 32, 0.45, MAT.chair));
    });

    // 그 밖의 장비·집기 (정수실 설비, 가구 등)
    objs.filter((o) => o.meta.type === "equipment" || o.meta.type === "furniture")
      .filter((o) => !["bed_console", "dialysis_bed", "dialysis_machine",
                       "station_desk2", "pipe", "module_frame"].includes(o.meta.key))
      .forEach((o) => {
        const r = rectOf(o);
        if (r.w < 8 || r.d < 8) return;
        box(root, r.x, r.y, r.w, r.d, 0.9, MAT.equip);
      });

    return root;
  }

  /* ───────── 뷰어 열기/닫기 ───────── */
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "view3d-overlay";
    overlay.innerHTML = `
      <div id="view3d-bar">
        <span id="view3d-title">3D 보기 — 드래그: 회전 · 휠: 확대 · 우클릭 드래그: 이동</span>
        <button id="view3d-top">평면뷰</button>
        <button id="view3d-iso">조감뷰</button>
        <button id="view3d-eye">눈높이</button>
        <button id="view3d-glb">glTF(.glb) 저장</button>
        <button id="view3d-obj">OBJ 저장</button>
        <button id="view3d-png">화면 저장</button>
        <button id="view3d-close">✕ 닫기</button>
      </div>
      <canvas id="view3d-canvas"></canvas>`;
    document.body.appendChild(overlay);
    canvasEl = overlay.querySelector("#view3d-canvas");
    overlay.querySelector("#view3d-close").addEventListener("click", close);
    overlay.querySelector("#view3d-top").addEventListener("click", () => setView("top"));
    overlay.querySelector("#view3d-iso").addEventListener("click", () => setView("iso"));
    overlay.querySelector("#view3d-eye").addEventListener("click", () => setView("eye"));
    overlay.querySelector("#view3d-glb").addEventListener("click", exportGLB);
    overlay.querySelector("#view3d-obj").addEventListener("click", exportOBJ);
    overlay.querySelector("#view3d-png").addEventListener("click", exportPNG);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay && !overlay.hidden) close();
    });
  }

  function setView(kind) {
    if (!camera || !lastRoom) return;
    const W = M(lastRoom.width), H = M(lastRoom.height);
    if (kind === "top") {                     // 평면뷰: 바로 위에서 내려다봄
      camera.position.set(W / 2, Math.max(W, H) * 1.05, H / 2 + 0.01);
      controls.target.set(W / 2, 0, H / 2);
    } else if (kind === "eye") {              // 눈높이: 병상 필드 앞 통로에 서서 병상 열을 바라봄
      const b = bedBounds;
      const cx = b ? M((b.x0 + b.x1) / 2) : W / 2;
      const zStand = b ? M(b.y1) + 1.6 : H - 1.2;
      const zLook = b ? M(b.y0) : H * 0.2;
      camera.position.set(cx, 1.6, Math.min(zStand, H - 0.6));
      controls.target.set(cx, 1.3, zLook);
    } else {                                  // 조감뷰
      camera.position.set(W * 0.92, Math.max(W, H) * 0.6, H * 1.15);
      controls.target.set(W / 2, 0, H / 2);
    }
    controls.update();
  }

  function open() {
    if (typeof THREE === "undefined") {
      alert("3D 라이브러리(vendor/three)를 불러오지 못했습니다.");
      return;
    }
    ensureOverlay();
    overlay.hidden = false;
    if (!renderer) {
      initMaterials();
      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
      camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      window.addEventListener("resize", resize);
    }
    // 장면 재구성 (열 때마다 현재 도면 반영)
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef1f4);
    const room = FloorCanvas.getRoom();
    const span = Math.max(M(room.width), M(room.height));
    const amb = new THREE.HemisphereLight(0xdfeaf5, 0x9aa0a6, 0.62);
    scene.add(amb);
    const sun = new THREE.DirectionalLight(0xfff4e2, 1.7);
    sun.position.set(M(room.width) * 0.7, span * 1.1, -M(room.height) * 0.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = span * 0.85;
    Object.assign(sun.shadow.camera, { left: -s, right: s * 2, top: s * 2, bottom: -s, near: 0.5, far: span * 4 });
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun);
    scene.add(buildScene());
    resize();
    setView("iso");
    if (!raf) loop();
  }

  function close() {
    if (overlay) overlay.hidden = true;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  function resize() {
    if (!renderer || !overlay || overlay.hidden) return;
    const w = overlay.clientWidth, h = overlay.clientHeight - 44;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  /* ───────── 내보내기 ───────── */
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  function exportGLB() {
    if (!scene) return;
    new THREE.GLTFExporter().parse(scene, (res) => {
      download(new Blob([res], { type: "model/gltf-binary" }), `인공신장실_3D_${stamp()}.glb`);
    }, undefined, { binary: true });
  }

  function exportOBJ() {
    if (!scene) return;
    const txt = new THREE.OBJExporter().parse(scene);
    download(new Blob([txt], { type: "text/plain" }), `인공신장실_3D_${stamp()}.obj`);
  }

  function exportPNG() {
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    renderer.domElement.toBlob((b) => download(b, `인공신장실_3D_${stamp()}.png`));
  }

  return { open, close };
})();
