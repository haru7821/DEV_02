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
  let flight = null;      // 드론 비행 녹화 진행 상태 (null이면 비행 중 아님)
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
    MAT.doorLeaf = std(0xd8c9a8, { roughness: 0.6 });   // 목재 문짝
    MAT.glass = new THREE.MeshStandardMaterial({        // 자동문 유리
      color: 0xbcd7e0, roughness: 0.1, metalness: 0.1,
      transparent: true, opacity: 0.45,
    });
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

  /* ═════════ 드론 안전 항로 ═════════
   * 촬영 드론이 벽·병상에 바짝 붙거나 뚫고 지나가지 않도록,
   *  ① 도면 전체를 격자로 훑어 '장애물까지의 여유(cm)' 지도를 만들고,
   *  ② 사람이 실제로 걷는 동선(주 동선·보조 동선) 위주로 항로를 잇는다.
   * 두 단계 모두 도면 좌표(cm)로 계산하고, 카메라에 줄 때만 m로 환산한다. */

  const NAV = {
    CELL: 5,      // 항로 격자 한 칸 (cm)
    WIDE: 90,     // 넉넉한 이격 (cm) — 공간이 되는 구간은 이만큼 띄운다
    SAFE: 56,     // 절대 최소 이격 (cm) — 최소 통로 1,160mm를 한가운데로 지나는 값
    IDEAL: 170,   // 이만큼 떨어지면 감점 없음 — 늘 통로 한가운데로 붙는다 (cm)
    EYE: 1.5,     // 통로 비행 고도 (m) — 사람 눈높이
    LOOK: 3.0,    // 진행 방향 앞을 내다보는 거리 (m)
    SPEED: 2.4,   // 통로 구간 최대 속도 (m/s) — 항로 길이를 이 값으로 자른다
  };
  let nav = null;      // 여유 지도 { cell, cols, rows, clear:Float32Array, w, h }
  let route = null;    // 사람 동선을 따르는 지상 항로 [{x,y}] (도면 cm)
  let navMin = NAV.WIDE;  // 이번 항로가 실제로 확보한 최소 이격 (cm)

  /** 통행을 막는 객체인가 — 배관·주석·문·모듈 경계선은 걸어서 지날 수 있다 */
  function navBlocks(o) {
    if (!o.meta || o.meta.isDoor) return false;
    if (["pipe", "annotation", "module_frame", "dimension"].includes(o.meta.key)) return false;
    const r = rectOf(o);
    return r.w > 5 && r.d > 5;
  }

  /**
   * 여유 지도를 만든다. 장애물 칸은 0, 나머지는 가장 가까운 장애물까지의 거리(cm).
   * 거리는 2패스 chamfer 변환으로 구한다 (격자 전체를 두 번만 훑어 빠르다).
   */
  function buildNav(room, objs) {
    const cell = NAV.CELL;
    const cols = Math.max(4, Math.ceil(room.width / cell));
    const rows = Math.max(4, Math.ceil(room.height / cell));
    const clear = new Float32Array(cols * rows).fill(Infinity);
    const fill = (x, y, w, d) => {
      const i0 = Math.max(0, Math.floor(x / cell)), i1 = Math.min(cols - 1, Math.ceil((x + w) / cell) - 1);
      const j0 = Math.max(0, Math.floor(y / cell)), j1 = Math.min(rows - 1, Math.ceil((y + d) / cell) - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) clear[j * cols + i] = 0;
    };
    // 외벽 4면 (실내 쪽으로 벽 두께만큼)
    fill(0, 0, room.width, WALL_T);
    fill(0, room.height - WALL_T, room.width, WALL_T);
    fill(0, 0, WALL_T, room.height);
    fill(room.width - WALL_T, 0, WALL_T, room.height);
    // 부속실·설비·병상 유닛 — 회전 객체는 축 정렬 바운딩으로 넉넉히 잡는다
    objs.filter(navBlocks).forEach((o) => {
      const r = rectOf(o);
      fill(r.x, r.y, r.w, r.d);
    });

    const D1 = cell, D2 = cell * Math.SQRT2;
    const relax = (k, kk, w) => { const v = clear[kk] + w; if (v < clear[k]) clear[k] = v; };
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!clear[k]) continue;
      if (i > 0) relax(k, k - 1, D1);
      if (j > 0) relax(k, k - cols, D1);
      if (i > 0 && j > 0) relax(k, k - cols - 1, D2);
      if (i < cols - 1 && j > 0) relax(k, k - cols + 1, D2);
    }
    for (let j = rows - 1; j >= 0; j--) for (let i = cols - 1; i >= 0; i--) {
      const k = j * cols + i;
      if (!clear[k]) continue;
      if (i < cols - 1) relax(k, k + 1, D1);
      if (j < rows - 1) relax(k, k + cols, D1);
      if (i < cols - 1 && j < rows - 1) relax(k, k + cols + 1, D2);
      if (i > 0 && j < rows - 1) relax(k, k + cols - 1, D2);
    }
    nav = { cell, cols, rows, clear, w: room.width, h: room.height };
  }

  /** 도면 좌표(cm)에서 장애물까지의 여유(cm) — 도면 밖은 0 */
  function clearAt(x, y) {
    if (!nav) return NAV.IDEAL;
    const i = Math.floor(x / nav.cell), j = Math.floor(y / nav.cell);
    if (i < 0 || j < 0 || i >= nav.cols || j >= nav.rows) return 0;
    return nav.clear[j * nav.cols + i];
  }

  const cellPt = (k) => ({
    x: ((k % nav.cols) + 0.5) * nav.cell,
    y: (Math.floor(k / nav.cols) + 0.5) * nav.cell,
  });
  const dist2D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** 주어진 점에서 가장 가까운 '안전한 칸' — 벽 속을 가리키는 목표점을 보정한다 */
  function snapFree(p, floor) {
    const { cols, rows, cell, clear } = nav;
    const ci = Math.min(cols - 1, Math.max(0, Math.floor(p.x / cell)));
    const cj = Math.min(rows - 1, Math.max(0, Math.floor(p.y / cell)));
    const R = Math.round(250 / cell);  // 2.5m 안에서 찾는다 (더 멀면 벽 너머로 건너뛸 수 있다)
    let best = -1, bestD = Infinity;
    for (let j = Math.max(0, cj - R); j <= Math.min(rows - 1, cj + R); j++) {
      for (let i = Math.max(0, ci - R); i <= Math.min(cols - 1, ci + R); i++) {
        const k = j * cols + i;
        if (clear[k] < floor) continue;
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
    }
    return best < 0 ? null : best;
  }

  /** A*용 최소 힙 */
  function minHeap() {
    const a = [], f = [];
    const swap = (x, y) => {
      const t = a[x]; a[x] = a[y]; a[y] = t;
      const s = f[x]; f[x] = f[y]; f[y] = s;
    };
    return {
      get size() { return a.length; },
      push(v, p) {
        a.push(v); f.push(p);
        for (let i = a.length - 1; i > 0;) {
          const par = (i - 1) >> 1;
          if (f[par] <= f[i]) break;
          swap(par, i); i = par;
        }
      },
      pop() {
        const top = a[0], v = a.pop(), p = f.pop();
        if (a.length) {
          a[0] = v; f[0] = p;
          for (let i = 0;;) {
            const l = i * 2 + 1, r = l + 1;
            let m = i;
            if (l < a.length && f[l] < f[m]) m = l;
            if (r < a.length && f[r] < f[m]) m = r;
            if (m === i) break;
            swap(m, i); i = m;
          }
        }
        return top;
      },
    };
  }

  /**
   * 여유 지도 위 A* — 이격이 floor(cm) 미만인 칸은 아예 지나지 않고,
   * 여유가 IDEAL에 못 미치는 만큼 비용을 더해 통로 한가운데로 붙는다.
   */
  function navPath(from, to, floor) {
    if (!nav) return null;
    const { cols, rows, cell, clear } = nav;
    const s = snapFree(from, floor), goal = snapFree(to, floor);
    if (s == null || goal == null) return null;
    if (s === goal) return [cellPt(s)];
    const gi = goal % cols, gj = Math.floor(goal / cols);
    const g = new Float32Array(cols * rows).fill(Infinity);
    const came = new Int32Array(cols * rows).fill(-1);
    const done = new Uint8Array(cols * rows);
    const open = minHeap();
    g[s] = 0;
    open.push(s, 0);
    while (open.size) {
      const k = open.pop();
      if (done[k]) continue;
      done[k] = 1;
      if (k === goal) break;
      const i = k % cols, j = Math.floor(k / cols);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const nk = nj * cols + ni;
          if (clear[nk] < floor) continue;
          // 대각선은 양옆이 모두 트여 있을 때만 — 모서리를 스치며 지나지 않는다
          if (di && dj && (clear[j * cols + ni] < floor || clear[nj * cols + i] < floor)) continue;
          const step = di && dj ? cell * Math.SQRT2 : cell;
          const ng = g[k] + step * (1 + 3 * Math.max(0, (NAV.IDEAL - clear[nk]) / NAV.IDEAL));
          if (ng < g[nk]) {
            g[nk] = ng;
            came[nk] = k;
            open.push(nk, ng + Math.hypot(ni - gi, nj - gj) * cell);
          }
        }
      }
    }
    if (came[goal] < 0) return null;
    const out = [];
    for (let k = goal; k >= 0; k = came[k]) {
      out.push(cellPt(k));
      if (k === s) break;
    }
    return out.reverse();
  }

  /** 두 점을 잇는 직선이 내내 floor 이상 떨어져 있는가 */
  function segSafe(a, b, floor) {
    const d = dist2D(a, b), n = Math.max(1, Math.ceil(d / (NAV.CELL * 0.6)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (clearAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < floor) return false;
    }
    return true;
  }

  /** 격자 계단 경로를 곧은 구간으로 당긴다 (여유가 유지되는 범위에서만) */
  function simplify(pts, floor) {
    if (pts.length < 3) return pts.slice();
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 80);
      for (; j > i + 1; j--) if (segSafe(pts[i], pts[j], floor)) break;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  /** 폴리라인을 일정 간격으로 다시 찍는다 */
  function resamplePoly(pts, step) {
    const out = [pts[0]];
    let carry = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], seg = dist2D(a, b);
      for (let d = step - carry; d < seg; d += step) {
        const t = d / seg;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
      carry = (carry + seg) % step;
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  const polyLen = (pts) => pts.reduce((s, p, i) => (i ? s + dist2D(pts[i - 1], p) : 0), 0);

  /** 앞에서부터 maxLen(cm)만큼만 남긴다 — 영상 길이에 맞춰 항로를 자른다 */
  function trimPoly(pts, maxLen) {
    const out = [pts[0]];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = dist2D(pts[i - 1], pts[i]);
      if (acc + d > maxLen) {
        const t = (maxLen - acc) / d;
        out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
                   y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t });
        break;
      }
      acc += d;
      out.push(pts[i]);
    }
    return out;
  }

  /**
   * 도면에 표시된 사람 동선을 읽는다 — 드론이 따라갈 길의 원본이다.
   *  · 주 동선   : 출입구에서 병상 필드 입구까지의 음영 구간
   *  · 보조 동선 : 병상 밴드 사이 간호 이동로(점선)
   *  · 후방 복도 / 후방 실 앞 통로 : 지원실 문 앞 통로 음영
   * 각 표시의 긴 축 중심선을 통로로 삼는다.
   */
  const FLOW_LANES = ["보조 동선", "후방 복도", "후방 실 앞 통로"];
  function flowMarks() {
    const cv = FloorCanvas.getCanvas && FloorCanvas.getCanvas();
    let main = null;
    const aisles = [];
    if (!cv) return { main, aisles };
    cv.getObjects().forEach((o) => {
      if (!o.meta || o.meta.key !== "annotation") return;
      const r = rectOf(o);
      if (o.meta.label === "주 동선") { if (!main || r.d > main.d) main = r; return; }
      if (!FLOW_LANES.includes(o.meta.label)) return;
      if (Math.max(r.w, r.d) < 200) return;      // 2m 미만은 통로로 안 본다
      aisles.push(r.w >= r.d
        ? { a: { x: r.x, y: r.y + r.d / 2 }, b: { x: r.x + r.w, y: r.y + r.d / 2 } }
        : { a: { x: r.x + r.w / 2, y: r.y }, b: { x: r.x + r.w / 2, y: r.y + r.d } });
    });
    return { main, aisles };
  }

  /**
   * 통로의 진입(탈출) 지점 — 표시선의 끝은 벽·모서리에 닿아 있을 수 있으므로,
   * 끝에서 안쪽으로 훑어 여유가 뚜렷이 커지는 첫 지점을 잡는다.
   */
  function laneEnd(ln, fromA) {
    const p = fromA ? ln.a : ln.b, q = fromA ? ln.b : ln.a;
    const len = dist2D(p, q) || 1;
    let best = null;
    for (let d = Math.min(40, len * 0.1); d <= len * 0.9; d += 20) {
      const t = d / len;
      const cl = clearAt(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t);
      const c = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, cl };
      if (cl >= NAV.WIDE) return c;                 // 넉넉히 트인 첫 지점이면 그대로
      if (!best || cl > best.cl + 5) best = c;      // 아니면 가장 트인 곳 (끝에 가깝게)
    }
    return best || { x: p.x, y: p.y };
  }

  /** 동선 표시가 없는 도면에서, 가장 트인 지점 몇 곳을 스스로 찾는다 */
  function openSpots(limit) {
    const { cols, rows, cell, clear } = nav;
    const cand = [];
    for (let j = 1; j < rows - 1; j += 2) {
      for (let i = 1; i < cols - 1; i += 2) {
        const c = clear[j * cols + i];
        if (c < NAV.WIDE) continue;
        cand.push({ x: (i + 0.5) * cell, y: (j + 0.5) * cell, c });
      }
    }
    cand.sort((a, b) => b.c - a.c);
    const picked = [];
    cand.some((p) => {
      if (picked.every((q) => dist2D(p, q) > 300)) picked.push(p);   // 3m 이상 떨어뜨려 고른다
      return picked.length >= limit;
    });
    return picked;
  }

  /**
   * 사람 동선을 따르는 지상 항로를 만든다.
   * 출입구 → 주 동선 → 통로(가까운 순, 지그재그)로 이어 붙이고, 구간마다 A*로 연결한다.
   * 이격은 WIDE(900mm)로 먼저 시도하고, 그만큼 넓지 않은 통로는 단계적으로 낮춰
   * 최소 SAFE(560mm)까지만 허용한다 — 실측 최소 통로(1,160mm)를 한가운데로 지나는 값이다.
   */
  function planRoute() {
    if (!nav) return null;
    const { main, aisles } = flowMarks();
    const W = nav.w, H = nav.h;
    const stops = [];
    if (main) {
      // 주 동선 음영의 긴 축 중심선 — 출입구(도면 아래쪽) 끝에서 필드 입구 쪽으로
      const ln = main.w >= main.d
        ? { a: { x: main.x, y: main.y + main.d / 2 }, b: { x: main.x + main.w, y: main.y + main.d / 2 } }
        : { a: { x: main.x + main.w / 2, y: main.y }, b: { x: main.x + main.w / 2, y: main.y + main.d } };
      const fromA = ln.a.y > ln.b.y || (ln.a.y === ln.b.y && ln.a.x > ln.b.x);
      stops.push(laneEnd(ln, fromA), laneEnd(ln, !fromA));
    } else {
      stops.push({ x: W / 2, y: H - 150 });
      stops.push({ x: W / 2, y: H / 2 });
    }
    // 통로: 현 위치에서 가까운 통로부터, 가까운 끝으로 들어가 반대 끝으로 빠진다
    const rest = aisles.slice();
    let cur = stops[stops.length - 1];
    while (rest.length) {
      let bi = 0, bd = Infinity, flip = false;
      rest.forEach((ln, i) => {
        const da = dist2D(cur, ln.a), db = dist2D(cur, ln.b);
        if (Math.min(da, db) < bd) { bd = Math.min(da, db); bi = i; flip = db < da; }
      });
      const ln = rest.splice(bi, 1)[0];
      stops.push(laneEnd(ln, !flip), laneEnd(ln, flip));
      cur = stops[stops.length - 1];
    }
    // 동선 표시가 없는(직접 그린) 도면 — 트인 곳을 이어 돌아본다
    const wander = () => openSpots(4).forEach((p) => {
      if (dist2D(p, stops[stops.length - 1]) > 200) stops.push(p);
    });
    if (!aisles.length) wander();

    // 항로 전체를 같은 이격으로 짠다 — 구간마다 기준이 다르면 이어 붙이는 지점이
    // 서로 다른 곳으로 붙어 경로가 튈 수 있다. 넓게 시작해 필요한 만큼만 좁힌다.
    const build = (floor) => {
      const pts = [];
      let from = stops[0], reached = 0;
      stops.slice(1).forEach((to) => {
        const seg = navPath(from, to, floor);
        // 못 가는 통로는 건너뛴다. 아직 한 구간도 못 이었으면 출발점 자체를 다음으로 옮긴다
        if (!seg || seg.length < 2) { if (!pts.length) from = to; return; }
        const s = simplify(seg, floor);
        const add = pts.length ? s.slice(1) : s;
        if (!add.length) return;
        if (pts.length && !segSafe(pts[pts.length - 1], add[0], floor)) return;
        add.forEach((p) => pts.push(p));
        from = to;
        reached++;
      });
      return { pts, reached, floor };
    };
    const pick = () => {
      let best = null;
      [NAV.WIDE, 72, NAV.SAFE].some((floor) => {
        const r = build(floor);
        if (!best || r.reached > best.reached
            || (r.reached === best.reached && polyLen(r.pts) > polyLen(best.pts) * 1.2)) best = r;
        return best.reached >= stops.length - 1;     // 모든 통로를 도는 이격을 찾으면 그만
      });
      return best;
    };
    let best = pick();
    // 통로가 막혀 항로가 너무 짧게 나오면, 트인 곳을 더 들러 실내를 고루 보여준다
    if (polyLen(best.pts) < 800 && aisles.length) {
      wander();
      const more = pick();
      if (polyLen(more.pts) > polyLen(best.pts)) best = more;
    }
    navMin = best.floor;
    if (best.pts.length < 2 || polyLen(best.pts) < 200) return null;
    return resamplePoly(best.pts, 30);
  }

  /** 카메라가 장애물에 붙으면 여유가 큰 쪽으로 밀어낸다 (스플라인 코너 컷 보정) */
  function keepClear(v, minCm) {
    if (!nav || v.y > WALL_H) return v;               // 벽 위 고도면 부딪힐 것이 없다
    const step = nav.cell / 2;
    for (let n = 0; n < 12; n++) {
      const x = v.x * 100, y = v.z * 100;
      if (clearAt(x, y) >= minCm) break;
      const gx = clearAt(x + nav.cell, y) - clearAt(x - nav.cell, y);
      const gy = clearAt(x, y + nav.cell) - clearAt(x, y - nav.cell);
      const len = Math.hypot(gx, gy);
      if (!len) break;
      v.x += (gx / len) * (step / 100);
      v.z += (gy / len) * (step / 100);
    }
    return v;
  }

  /** 2D 객체의 도면 좌표 사각형(cm) — 회전은 축 정렬 바운딩으로 근사 */
  function rectOf(o) {
    const r = o.getBoundingRect(true);
    return { x: r.left, y: r.top, w: r.width, d: r.height };
  }

  /**
   * 회전을 반영해 배치한다.
   * build(g, w, d)는 로컬 좌표 (0,0)~(w,d)에 형상을 만든다. 만들어진 형상을
   * 객체 중심으로 옮긴 뒤, 도면의 회전각만큼 Y축으로 돌린다.
   * (fabric의 각도는 화면 기준 시계방향 → three.js에서는 -각도)
   */
  function placeRotated(parent, o, build) {
    const w = o.getScaledWidth(), d = o.getScaledHeight();
    const inner = new THREE.Group();
    build(inner, w, d);
    inner.position.set(-M(w) / 2, 0, -M(d) / 2);  // 로컬 원점을 중심으로
    const wrap = new THREE.Group();
    wrap.add(inner);
    const c = o.getCenterPoint();
    wrap.position.set(M(c.x), 0, M(c.y));
    wrap.rotation.y = -((o.angle || 0) * Math.PI) / 180;
    parent.add(wrap);
    return wrap;
  }

  /* ───────── 문짝 ─────────
   * 개구부만 뚫으면 3D가 허전하고 개폐 방향도 알 수 없다.
   * 문은 모두 '열린 상태'로 그린다 — 여닫이는 실내로 젖혀진 문짝,
   * 미닫이·자동문은 개구부 밖(벽면)으로 완전히 밀려난 패널 + 상부 레일. */
  const DOOR_LEAF_T = 4;      // 문짝 두께(cm)
  const OPEN_DEG = 80;        // 여닫이 열림 각 (거의 활짝 — 통행 가능 폭을 보여준다)
  const WALL_T = 10;          // 벽 두께(cm) — 미닫이 패널을 벽면에 붙일 때 쓴다

  /**
   * 문의 '개구부 중심'(cm). 문 그룹의 바운딩 박스는 개폐 호(arc)까지 포함해
   * 실내 쪽으로 치우치므로, 그룹 첫 자식(개구부 사각형)의 중심을 변환해서 쓴다.
   * 이 값을 안 쓰면 벽 개구부가 엉뚱한 곳에 뚫리거나 아예 안 뚫린다.
   */
  function doorAnchor(o) {
    const parts = o.getObjects ? o.getObjects() : null;
    if (parts && parts.length) {
      return fabric.util.transformPoint(parts[0].getCenterPoint(), o.calcTransformMatrix());
    }
    return o.getCenterPoint();
  }

  function buildDoor(group, o) {
    const kind = o.meta.key;
    const dw = (doorData[kind] && doorData[kind].width) || 90;
    const mat = MAT.doorLeaf;
    const c = doorAnchor(o);
    const wrap = new THREE.Group();
    wrap.position.set(M(c.x), 0, M(c.y));
    wrap.rotation.y = -((o.angle || 0) * Math.PI) / 180;
    group.add(wrap);

    // 열리는 방향(로컬 Z 부호). 2D 문 심볼은 문짝·개폐 궤적을 로컬 -Y에 그리고,
    // addDoor의 roomSide 각도가 그 -Y를 '열리는 쪽'으로 돌려놓는다. 캔버스 y ≡ 3D z
    // 이므로 3D에서도 로컬 -Z가 열리는 쪽 — 2D 도면의 개폐 방향을 그대로 따른다.
    // (개폐 방향의 단일 기준은 addDoor의 roomSide다. 기본은 실 안쪽,
    //  정수실만 바깥여닫이 — canvas.js의 wallDoor opts.outward 참고)
    const IN = -1;

    const leaf = (len, hingeX, dir, angle) => {
      // 로컬 X축을 따라 개구부가 놓인다. hingeX에서 angle만큼 열린 문짝.
      const pivot = new THREE.Group();
      pivot.position.set(M(hingeX), 0, 0);
      pivot.rotation.y = angle;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(M(len), DOOR_H, M(DOOR_LEAF_T)), mat);
      m.position.set((dir * M(len)) / 2, DOOR_H / 2, 0);
      m.castShadow = true;
      pivot.add(m);
      wrap.add(pivot);
    };
    // 힌지에서 dir 쪽으로 뻗은 문짝이 실 안쪽(IN)으로 젖혀지는 회전각
    const openAngle = (dir) => -IN * dir * OPEN_DEG * Math.PI / 180;

    if (kind === "double_swing_door") {           // 양짝: 양쪽에서 각각 안쪽으로
      leaf(dw / 2, -dw / 2, 1, openAngle(1));
      leaf(dw / 2, dw / 2, -1, openAngle(-1));
    } else if (kind === "swing_door") {           // 외짝 여닫이 — 안쪽으로
      leaf(dw, -dw / 2, 1, openAngle(1));
    } else {                                      // 미닫이·자동문: 열린 상태
      // 문짝을 개구부 밖으로 완전히 밀어낸다. 개구부 안에는 아무것도 두지 않아야
      // 밖에서 봤을 때 뚫려 보이고, 통행 가능 폭이 그대로 읽힌다.
      const glass = kind === "auto_door";
      const pmat = glass ? MAT.glass : mat;
      const off = IN * M(WALL_T / 2 + DOOR_LEAF_T / 2);  // 실 안쪽 벽면에 붙은 패널
      const panel = (len, cx) => {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(M(len), DOOR_H, M(DOOR_LEAF_T)), pmat);
        m.position.set(M(cx), DOOR_H / 2, off);
        m.castShadow = true;
        wrap.add(m);
      };
      if (glass) {                 // 자동문: 양쪽으로 갈라져 완전 개방
        panel(dw / 2, -dw * 0.75);
        panel(dw / 2, dw * 0.75);
      } else {                     // 미닫이 외짝: 한쪽으로 완전히 밀림
        panel(dw, -dw);
      }
      // 상부 레일 — 열린 문짝이 어디에 물려 있는지 보이게 한다 (개구부 + 문짝 주차 구간)
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(M(dw * 2), M(6), M(DOOR_LEAF_T + 3)), MAT.console);
      rail.position.set(glass ? 0 : -M(dw) * 0.5, DOOR_H + M(3), off);
      wrap.add(rail);
    }
  }

  /** 병상 모듈: 침대(프레임+매트리스+베개) + 투석기 */
  function buildBedUnit(parent, unit) {
    // 유닛 자체의 회전은 placeRotated가 처리하고, 자식은 '회전 전' 로컬 좌표로 그린다
    placeRotated(parent, unit, (group, uw, ud) => buildBedParts(group, unit, uw, ud));
  }

  function buildBedParts(group, unit, uw, ud) {
    const at = (child) => {
      // 그룹 로컬 좌표(중심 기준) → 로컬 사각형 좌표(0,0 기준)
      const w = child.width * (child.scaleX || 1) * (unit.scaleX || 1);
      const d = child.height * (child.scaleY || 1) * (unit.scaleY || 1);
      const p = child.getCenterPoint();
      return { x: p.x * (unit.scaleX || 1) + uw / 2 - w / 2,
               y: p.y * (unit.scaleY || 1) + ud / 2 - d / 2, w, d };
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
      const p = doorAnchor(o);
      // 폭은 카탈로그 값(개폐 호가 포함된 바운딩이 아니라)을 쓴다
      const w = (doorData[o.meta.key] && doorData[o.meta.key].width)
        || Math.min(rectOf(o).w, rectOf(o).d);
      return { cx: p.x, cy: p.y, w: w * (o.scaleX || 1) };
    });
    const WT = WALL_T; // 외벽 두께(cm)
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
      // 회전 반영: 로컬 좌표(0,0)~(w,d)에 바닥·4면 벽을 만들고 그룹째 돌린다
      placeRotated(root, o, (g, w, d) => {
        const f = new THREE.Mesh(new THREE.PlaneGeometry(M(w), M(d)), fmat);
        f.rotation.x = -Math.PI / 2;
        f.position.set(M(w) / 2, 0.006, M(d) / 2);
        f.receiveShadow = true;
        g.add(f);
        // 문 개구부는 회전 없는 실에서만 정확하므로, 회전된 실은 벽을 통으로 세운다
        const rot = Math.abs(o.angle || 0) > 0.5;
        const gp = (gx, gy, len, horiz) => (rot ? [] : gapsOn(gx, gy, len, horiz));
        wallWithGaps(g, 0, 0, w, t, PARTITION_H, MAT.partition, true, gp(r.x, r.y, w, true));
        wallWithGaps(g, 0, d - t, w, t, PARTITION_H, MAT.partition, true, gp(r.x, r.y + r.d, w, true));
        wallWithGaps(g, 0, 0, d, t, PARTITION_H, MAT.partition, false, gp(r.x, r.y, d, false));
        wallWithGaps(g, w - t, 0, d, t, PARTITION_H, MAT.partition, false, gp(r.x + r.w, r.y, d, false));
      });
    });

    // 배관 콘솔 (병상 머리맡 덕트)
    objs.filter((o) => o.meta.key === "bed_console").forEach((o) => {
      placeRotated(root, o, (g, w, d) => box(g, 0, 0, w, d, 0.95, MAT.console));
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
      placeRotated(root, o, (g, w, d) => {
        box(g, 0, d * 0.42, w, d * 0.58, 0.75, MAT.desk);   // 상판
        [0.25, 0.72].forEach((f) =>                          // 의자 2개 (뒤쪽 = 카운터 쪽)
          box(g, w * f - 18, 4, 36, 32, 0.45, MAT.chair));
      });
    });

    // 그 밖의 장비·집기 (정수실 설비, 가구 등)
    objs.filter((o) => o.meta.type === "equipment" || o.meta.type === "furniture")
      .filter((o) => !["bed_console", "dialysis_bed", "dialysis_machine",
                       "station_desk2", "pipe", "module_frame"].includes(o.meta.key))
      .forEach((o) => {
        if (o.getScaledWidth() < 8 || o.getScaledHeight() < 8) return;
        placeRotated(root, o, (g, w, d) => box(g, 0, 0, w, d, 0.9, MAT.equip));
      });

    // 문짝 (여닫이·양짝·미닫이·자동문)
    objs.filter((o) => o.meta.isDoor).forEach((o) => buildDoor(root, o));

    // 드론 항로: 장애물 여유 지도 → 사람 동선을 따르는 지상 항로
    buildNav(room, objs);
    route = planRoute();

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
        <select id="view3d-dur" title="영상 길이">
          <option value="10" selected>10초</option>
          <option value="15">15초</option>
          <option value="25">25초</option>
          <option value="40">40초</option>
        </select>
        <button id="view3d-mp4" title="드론 카메라로 전체 레이아웃을 돌아보는 영상 저장">🎬 영상 저장</button>
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
    overlay.querySelector("#view3d-mp4").addEventListener("click", recordFlight);
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
    } else if (kind === "eye") {              // 눈높이: 사람이 다니는 통로에 서서 실내를 바라봄
      if (route && route.length > 3) {        // 항로 시작점 = 출입구 안쪽 통로
        const p = route[0], q = route[Math.min(route.length - 1, 12)];
        camera.position.set(M(p.x), 1.6, M(p.y));
        controls.target.set(M(q.x), 1.35, M(q.y));
        controls.update();
        return;
      }
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
    if (flight) flight.finish();     // 녹화 중이면 지금까지 찍힌 분량으로 마무리
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
    if (flight) flight.tick();
    else if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  /* ───────── 드론 비행 영상 ─────────
   * 카메라를 스플라인 경로로 움직이며 캔버스를 그대로 녹화한다.
   * 외부 라이브러리·서버 없이 브라우저 표준(captureStream + MediaRecorder)만 쓴다. */

  /**
   * 비행 경로. 위치·주시점을 같은 파라미터 u로 읽는 두 개의 스플라인으로 만든다.
   * ① 상공 270° 선회 → ② 출입구 상공으로 하강 → ③ 사람 동선 저공 비행 → ④ 재상승
   *
   * ③은 planRoute가 만든 '사람이 다니는 통로' 항로를 그대로 따르므로,
   * 어느 지점에서도 벽·병상과 최소 560mm(통로가 넉넉하면 900mm) 이상 떨어진다. 항로를 만들 수
   * 없는 도면(통로가 막혔거나 객체가 거의 없는 경우)은 벽 위 저공 스윕으로 대체한다.
   *
   * 구간(phase)마다 '시간 비중'을 주고 각 구간을 호 길이로 균등 분할해 점을 찍으므로,
   * 스플라인을 파라미터로 균등하게 읽으면 구간 안에서 속도가 일정해진다.
   */
  function dronePath(sec) {
    const W = M(lastRoom.width), H = M(lastRoom.height);
    const cx = W / 2, cz = H / 2, span = Math.max(W, H);
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const center = () => V(cx, 0, cz);
    const smooth = (s) => s * s * (3 - 2 * s);
    const mix = (a, b, t) => new THREE.Vector3().lerpVectors(a, b, t);
    const phases = [];

    // 통로 항로(있으면) — 영상 길이에 맞춰 최대 속도를 넘지 않게 잘라 쓴다
    const budgetCm = sec * NAV.SPEED * 100 * 0.46;
    const ground = route && trimPoly(route, budgetCm);
    let gp = null;
    if (ground && ground.length > 1) {
      const pm = ground.map((p) => ({ x: M(p.x), z: M(p.y) }));
      const cum = [0];
      for (let i = 1; i < pm.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(pm[i].x - pm[i - 1].x, pm[i].z - pm[i - 1].z));
      }
      const total = cum[cum.length - 1];
      // 항로 위 거리 d(m) 지점의 좌표 (끝을 넘으면 진행 방향으로 연장)
      gp = (d) => {
        if (d <= 0) return pm[0];
        if (d >= total) {
          const a = pm[pm.length - 2], b = pm[pm.length - 1];
          const seg = Math.hypot(b.x - a.x, b.z - a.z) || 1, e = d - total;
          return { x: b.x + ((b.x - a.x) / seg) * e, z: b.z + ((b.z - a.z) / seg) * e };
        }
        let i = 1;
        while (i < cum.length - 1 && cum[i] < d) i++;
        const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
        return { x: pm[i - 1].x + (pm[i].x - pm[i - 1].x) * t,
                 z: pm[i - 1].z + (pm[i].z - pm[i - 1].z) * t };
      };
      gp.total = total;
    }

    // 주시점은 '조금 앞'과 '멀리 앞'을 섞어 본다 — 모퉁이를 미리 돌아봐
    // 벽을 정면으로 마주 보는 구간이 생기지 않는다.
    const look = (d) => {
      const a = gp(d + NAV.LOOK), b = gp(d + NAV.LOOK * 2.4);
      return { x: a.x * 0.35 + b.x * 0.65, z: a.z * 0.35 + b.z * 0.65 };
    };
    const startPt = gp ? gp(0) : { x: cx, z: H * 0.85 };
    // ① 상공 270° 선회 — 진입할 출입구 위에서 끝나도록 시작 각도를 잡는다
    const endA = Math.atan2(startPt.z - cz, startPt.x - cx);
    phases.push({ w: 0.30, at(s) {
      const a = endA - Math.PI * 1.5 * (1 - s);
      const r = span * (0.95 - 0.28 * s);
      return { p: V(cx + Math.cos(a) * r, span * (0.60 - 0.26 * s), cz + Math.sin(a) * r),
               t: center() };
    } });
    const orbitEnd = phases[0].at(1).p.clone();

    if (gp) {
      const look0 = look(0);
      // ② 출입구 상공 → 통로 고도로 수직 하강 (지붕이 없으므로 그대로 내려앉는다)
      phases.push({ w: 0.15, at(s) {
        const e = smooth(s);
        const xz = mix(V(orbitEnd.x, 0, orbitEnd.z), V(startPt.x, 0, startPt.z), Math.min(1, e * 1.4));
        const y = orbitEnd.y + (NAV.EYE - orbitEnd.y) * (e * e);
        return { p: V(xz.x, y, xz.z),
                 t: mix(center(), V(look0.x, 1.35, look0.z), e) };
      } });
      // ③ 사람 동선 저공 비행 — 진행 방향 앞을 내다보며 통로 한가운데를 지난다
      // 항로가 짧은 도면은 이 구간 비중을 줄여, 제자리에 가까운 느린 비행이 되지 않게 한다
      phases.push({ w: 0.45 * Math.max(0.45, Math.min(1, (gp.total * 100) / budgetCm)), at(s) {
        const d = s * gp.total;
        const p = gp(d), t = look(d);
        return { p: V(p.x, NAV.EYE, p.z), t: V(t.x, 1.35, t.z) };
      } });
      // ④ 재상승 — 통로 끝에서 떠올라 전체를 담고 끝낸다
      const endP = gp(gp.total), endL = look(gp.total);
      phases.push({ w: 0.10, at(s) {
        const e = smooth(s);
        const xz = mix(V(endP.x, 0, endP.z), V(W * 0.9, 0, H * 1.05), e * e);
        return { p: V(xz.x, NAV.EYE + (span * 0.5 - NAV.EYE) * e, xz.z),
                 t: mix(V(endL.x, 1.35, endL.z), center(), e) };
      } });
    } else {
      // 항로를 못 만든 도면 — 벽 위(3.2m) 저공 스윕으로 어디에도 닿지 않게 지난다
      const b = bedBounds;
      const fx = b ? M((b.x0 + b.x1) / 2) : cx;
      const zA = b ? M(b.y1) + 1.5 : H * 0.85, zB = b ? M(b.y0) - 1.5 : H * 0.15;
      phases.push({ w: 0.55, at(s) {
        const e = smooth(s);
        const y = orbitEnd.y + (3.3 - orbitEnd.y) * Math.min(1, e * 2.2);
        return { p: V(fx, y, zA + (zB - zA) * e), t: V(fx, 0.8, zB + (zB - zA) * 0.25) };
      } });
      phases.push({ w: 0.15, at(s) {
        const e = smooth(s);
        return { p: V(fx + (W * 0.9 - fx) * e, 3.3 + (span * 0.5 - 3.3) * e, zB + (H * 1.05 - zB) * e),
                 t: center() };
      } });
    }

    // 구간별 시간 비중대로 점을 찍는다 (구간 안에서는 등간격 = 등속)
    const N = 320, tot = phases.reduce((a, p) => a + p.w, 0);
    const pos = [], tgt = [];
    phases.forEach((ph, pi) => {
      const n = Math.max(2, Math.round((N * ph.w) / tot));
      for (let i = pi ? 1 : 0; i <= n; i++) {
        const { p, t } = ph.at(i / n);
        pos.push(p);
        tgt.push(t);
      }
    });
    const curve = (pts) => new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.15);
    return { pos: curve(pos), tgt: curve(tgt) };
  }

  /** 이 브라우저가 쓸 수 있는 영상 형식 — mp4(H.264) 우선, 없으면 webm */
  function pickMime() {
    if (!window.MediaRecorder) return "";
    return [
      "video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4",
      "video/webm;codecs=vp9", "video/webm",
    ].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  }

  function recordFlight() {
    if (!renderer || !scene || !camera || !lastRoom || flight) return;
    const cv = renderer.domElement;
    if (!cv.captureStream || !window.MediaRecorder) {
      alert("이 브라우저는 화면 녹화를 지원하지 않습니다.\nChrome·Edge 최신 버전에서 사용해 주세요.");
      return;
    }
    const mime = pickMime();
    if (!mime) { alert("녹화 가능한 영상 코덱이 없습니다."); return; }

    const bar = overlay.querySelector("#view3d-title");
    const barText = bar.textContent;
    const ui = [...overlay.querySelectorAll("#view3d-bar button, #view3d-bar select")]
      .filter((el) => el.id !== "view3d-close");
    ui.forEach((el) => { el.disabled = true; });

    // 녹화 해상도: 화면 크기 그대로, 픽셀비 1 (인코더를 위해 짝수로 맞춘다)
    const oldPR = renderer.getPixelRatio();
    const w = Math.floor(cv.clientWidth / 2) * 2;
    const h = Math.floor(cv.clientHeight / 2) * 2;
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    controls.enabled = false;

    const sec = Number(overlay.querySelector("#view3d-dur").value) || 10;
    const path = dronePath(sec);
    const chunks = [];
    const rec = new MediaRecorder(cv.captureStream(30), {
      mimeType: mime, videoBitsPerSecond: 12e6,
    });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
      if (chunks.length) {
        download(new Blob(chunks, { type: mime }), `인공신장실_3D_비행_${stamp()}.${ext}`);
      }
      // 원상 복구
      renderer.setPixelRatio(oldPR);
      resize();
      controls.enabled = true;
      setView("iso");
      bar.textContent = barText;
      ui.forEach((el) => { el.disabled = false; });
    };

    const t0 = performance.now();
    flight = {
      tick() {
        const u = Math.min(1, (performance.now() - t0) / (sec * 1000));
        // 시작·끝만 부드럽게 — 구간별 시간 비중은 그대로 두고 속도만 완만히 여닫는다
        const e = u - (0.4 * Math.sin(2 * Math.PI * u)) / (2 * Math.PI);
        camera.position.copy(path.pos.getPoint(e));
        // 스플라인이 모서리를 질러가더라도 벽·장비에 붙지 않게 마지막으로 밀어낸다
        keepClear(camera.position, navMin * 0.98);
        camera.lookAt(path.tgt.getPoint(e));
        bar.textContent = `● 녹화 중 ${Math.round(u * 100)}% — ${w}×${h} · ${sec}초`;
        if (u >= 1) flight.finish();
      },
      finish() {
        if (!flight) return;
        flight = null;
        if (rec.state !== "inactive") rec.stop();
      },
    };
    rec.start();
  }

  /* ───────── 내보내기 ───────── */
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);      // 문서에 붙여야 파일명이 확실히 적용된다
    a.click();
    a.remove();
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
