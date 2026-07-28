/**
 * canvas.js — Fabric.js 캔버스 제어 (배치·이동·회전·스냅·그룹화·자동배치)
 *
 * 좌표계: 1px = 1cm. 화면 배율은 fabric의 zoom으로만 조절하므로
 * 모든 객체의 left/top/width/height 값이 곧 실제 cm 치수다.
 */
const FloorCanvas = (() => {
  let canvas = null;          // fabric.Canvas
  let room = { width: 2500, height: 1500 }; // 병실 내부 치수(cm) — 기본 25m × 15m
  let snapSize = 10;          // 스냅 단위(cm). 0 = 끄기
  let pipeMode = false;       // 배관 그리기 모드
  let pipeType = "inlet";     // 그리는 중인 배관 타입 ("inlet" | "drain")
  let pipePoints = [];        // 그리는 중인 배관 꼭짓점
  let pipePreview = null;     // 미리보기 라인
  let bedCounter = 0;         // 병상 번호(HD1, HD2, …) 순차 카운터
  let blueprintMode = false;  // 흑백 도면(청사진) 모드

  // ── 실행 취소/다시 실행 히스토리 ──
  let history = [];           // JSON 스냅샷 스택
  let histIndex = -1;         // 현재 스냅샷 위치
  let histDepth = 0;          // >0 이면 일괄 작업 중 (기록 안 함)
  let restoring = false;      // undo/redo 복원 중
  let histTimer = null;
  let clipboard = null;       // 복사/붙여넣기 버퍼

  const GRID_STEP = 50;       // 화면에 그리는 그리드 간격(cm)
  let WALL = 10;              // 벽 두께(cm) — setWallThickness()로 변경
  let consoleDepth = 25;      // 배관 콘솔 두께(cm) — setConsoleDepth()로 변경
  let moduleWidth = 180;      // 병상 모듈 폭(cm): 침대+투석기 존 (참고 도면 1800mm 피치)
  let stationSeats = 4;       // 간호 스테이션 좌석 수 (2인 데스크 단위, 최대 8석)

  /** 벽 두께 설정(cm). 다음 새 도면/자동 배치부터 적용된다. */
  function setWallThickness(t) {
    WALL = Math.min(40, Math.max(5, Math.round(+t) || 10));
  }

  /** 배관 콘솔 두께 설정(cm). 이후 추가/자동 배치되는 콘솔부터 적용된다. */
  function setConsoleDepth(t) {
    consoleDepth = Math.min(60, Math.max(10, Math.round(+t) || 25));
  }

  /** 병상 모듈 폭 설정(cm). 침대(120cm)+투석기 존으로 구성되며 최소 175cm. */
  function setModuleWidth(t) {
    moduleWidth = Math.min(300, Math.max(175, Math.round(+t) || 180));
  }

  /** 간호 스테이션 좌석 수 설정 (2~8석, 2인 데스크 단위로 반올림). */
  function setStationSeats(n) {
    stationSeats = Math.min(8, Math.max(2, Math.round((+n || 4) / 2) * 2));
  }

  /* ───────────────── 초기화 ───────────────── */
  function init(el) {
    canvas = new fabric.Canvas(el, {
      preserveObjectStacking: true,
      selection: true,
      backgroundColor: "#ffffff",
    });
    resize();
    window.addEventListener("resize", resize);

    // ── 그리드 스냅 + 엣지 자석: 이동 중 그리드 단위 정렬 후,
    //    다른 객체의 엣지가 12cm 이내면 자석처럼 흡착한다 ──
    canvas.on("object:moving", (e) => {
      const o = e.target;
      let L = o.left, T = o.top;
      if (snapSize) {
        L = Math.round(L / snapSize) * snapSize;
        T = Math.round(T / snapSize) * snapSize;
      }
      const EDGE = 12; // 엣지 흡착 거리(cm)
      const w = o.getScaledWidth(), h = o.getScaledHeight();
      const selected = new Set(canvas.getActiveObjects());
      let bestDX = null, bestDY = null;
      getObjects().forEach((ob) => {
        if (ob === o || selected.has(ob) || ob.meta.key === "pipe") return;
        const b = ob.getBoundingRect(true);
        const bR = b.left + b.width, bB = b.top + b.height;
        // 세로 구간이 겹칠 때만 가로 흡착 (멀리 떨어진 객체에 붙는 것 방지)
        if (T < bB + 50 && T + h > b.top - 50) {
          [bR - L, b.left - (L + w), b.left - L, bR - (L + w)].forEach((d) => {
            if (Math.abs(d) <= EDGE && (bestDX === null || Math.abs(d) < Math.abs(bestDX))) bestDX = d;
          });
        }
        if (L < bR + 50 && L + w > b.left - 50) {
          [bB - T, b.top - (T + h), b.top - T, bB - (T + h)].forEach((d) => {
            if (Math.abs(d) <= EDGE && (bestDY === null || Math.abs(d) < Math.abs(bestDY))) bestDY = d;
          });
        }
      });
      o.set({ left: L + (bestDX ?? 0), top: T + (bestDY ?? 0) });
    });

    // ── 크기 조절 스냅: 드래그 스케일 시 10mm(1cm) 단위로 단계 조절 ──
    canvas.on("object:scaling", (e) => {
      const o = e.target;
      const w = Math.max(1, Math.round(o.getScaledWidth()));
      const h = Math.max(1, Math.round(o.getScaledHeight()));
      o.set({ scaleX: w / o.width, scaleY: h / o.height });
    });

    // ── 회전 스냅: 15° 단위 ──
    canvas.on("object:rotating", (e) => {
      e.target.set("angle", Math.round(e.target.angle / 15) * 15);
    });

    // ── 휠 확대/축소 ──
    canvas.on("mouse:wheel", (opt) => {
      const delta = opt.e.deltaY;
      let zoom = canvas.getZoom() * Math.pow(0.999, delta);
      zoom = Math.min(4, Math.max(0.05, zoom));
      canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
      opt.e.preventDefault();
      opt.e.stopPropagation();
    });

    // ── Alt+드래그 화면 이동 / 배관 클릭 입력 ──
    let panning = false;
    canvas.on("mouse:down", (opt) => {
      if (pipeMode) { addPipePoint(canvas.getPointer(opt.e)); return; }
      if (opt.e.altKey) { panning = true; canvas.selection = false; }
    });
    canvas.on("mouse:move", (opt) => {
      if (panning) {
        const vpt = canvas.viewportTransform;
        vpt[4] += opt.e.movementX;
        vpt[5] += opt.e.movementY;
        canvas.requestRenderAll();
      } else if (pipeMode && pipePoints.length) {
        drawPipePreview(canvas.getPointer(opt.e));
      }
    });
    canvas.on("mouse:up", () => { panning = false; canvas.selection = true; });
    canvas.on("mouse:dblclick", () => { if (pipeMode) finishPipe(); });

    // ── 히스토리 기록: 객체 추가/삭제/수정 시 스냅샷 저장 ──
    canvas.on("object:added", saveHistory);
    canvas.on("object:removed", saveHistory);
    canvas.on("object:modified", saveHistory);

    newRoom(room.width, room.height);
  }

  function resize() {
    const wrap = document.getElementById("canvas-wrap");
    canvas.setWidth(wrap.clientWidth);
    canvas.setHeight(wrap.clientHeight);
    canvas.requestRenderAll();
  }

  /* ───────────────── 병실(도면) 생성 ───────────────── */
  function newRoom(w, h) {
    beginBulk();
    room = { width: w, height: h };
    bedCounter = 0; // 새 도면이므로 병상 번호 초기화
    canvas.clear();
    canvas.backgroundColor = "#ffffff";
    drawGrid();
    drawWalls();
    drawWallNote();
    fitToScreen();
    endBulk();
  }

  function drawGrid() {
    for (let x = 0; x <= room.width; x += GRID_STEP) {
      canvas.add(staticLine([x, 0, x, room.height], "#eceff1"));
    }
    for (let y = 0; y <= room.height; y += GRID_STEP) {
      canvas.add(staticLine([0, y, room.width, y], "#eceff1"));
    }
  }

  function drawWalls() {
    const wall = new fabric.Rect({
      left: -WALL, top: -WALL,
      width: room.width + WALL * 2, height: room.height + WALL * 2,
      fill: "transparent",
      stroke: "#263238", strokeWidth: WALL,
      selectable: false, evented: false,
    });
    wall.meta = { key: "wall", label: "외벽" };
    canvas.add(wall);
  }

  /** 도면 좌측 하단(외벽 바로 아래)에 벽체 두께 주석을 표시 */
  function drawWallNote() {
    const note = new fabric.Text(`벽체 THK ${WALL * 10}mm`, {
      left: -WALL, top: room.height + WALL + 8,
      fontSize: 26, fill: "#455A64",
      selectable: false, evented: false,
    });
    note.meta = { key: "annotation", label: "벽체 두께 주석" };
    canvas.add(note);
  }

  function staticLine(coords, color) {
    const l = new fabric.Line(coords, {
      stroke: color, strokeWidth: 1, selectable: false, evented: false,
    });
    l.meta = { key: "grid" };
    return l;
  }

  function fitToScreen() {
    const margin = 60;
    const zoom = Math.min(
      (canvas.getWidth() - margin) / (room.width + WALL * 2),
      (canvas.getHeight() - margin) / (room.height + WALL * 2)
    );
    canvas.setViewportTransform([zoom, 0, 0, zoom, margin / 2 + WALL * zoom, margin / 2 + WALL * zoom]);
    canvas.requestRenderAll();
  }

  /* ───────────────── 배경 도면 사진 ───────────────── */
  function setBackgroundImage(dataUrl, realWidthCm) {
    fabric.Image.fromURL(dataUrl, (img) => {
      const scale = realWidthCm / img.width;
      img.set({ scaleX: scale, scaleY: scale, opacity: 0.5, selectable: false, evented: false });
      canvas.setBackgroundImage(img, canvas.renderAll.bind(canvas));
      newRoomKeepBackground(realWidthCm, Math.round(img.height * scale));
    });
  }

  function newRoomKeepBackground(w, h) {
    const bg = canvas.backgroundImage;
    newRoom(w, h);
    if (bg) canvas.setBackgroundImage(bg, canvas.renderAll.bind(canvas));
  }

  /* ───────────────── 장비 에셋 추가 ───────────────── */
  function addEquipment(key, opts = {}) {
    let spec = equipmentData[key];
    if (!spec) return null;
    // 배관 콘솔은 설정된 두께를 적용, opts.width/height로 개별 치수 재정의 가능
    if (key === "bed_console") spec = { ...spec, height: consoleDepth };
    if (opts.width || opts.height) {
      spec = { ...spec, width: opts.width ?? spec.width, height: opts.height ?? spec.height };
    }

    // 원형 계열(여과탱크·필터·배수구)은 사각형 대신 타원으로 렌더링
    const isRound = spec.symbol === "tank" || spec.symbol === "circle";
    const rect = isRound
      ? new fabric.Ellipse({
          rx: spec.width / 2, ry: spec.height / 2,
          fill: spec.color + "33",
          stroke: spec.color, strokeWidth: 3,
          originX: "center", originY: "center",
        })
      : new fabric.Rect({
          width: spec.width, height: spec.height,
          fill: spec.color + "55",
          stroke: spec.color, strokeWidth: 3,
          originX: "center", originY: "center",
        });
    const vertical = spec.height > spec.width * 1.4; // 세로형은 라벨을 세로로
    const text = new fabric.Text(spec.shortLabel ?? spec.label, {
      fontSize: Math.max(14, Math.min(spec.width, spec.height) / 6),
      fill: "#37474f",
      originX: "center", originY: "center",
      angle: vertical ? 90 : 0,
    });
    // 라벨이 사각형보다 크면 그룹 바운딩 박스가 커져 간격 계산이 틀어지므로 축소
    const maxLen = (vertical ? spec.height : spec.width) * 0.9;
    if (text.width > maxLen) {
      const s = maxLen / text.width;
      text.set({ scaleX: s, scaleY: s });
    }
    const parts = [rect];
    // 코어/샤프트(PS/EPS) 기호: 사각형 안에 대각선 X 두 줄
    if (spec.symbol === "cross") {
      parts.push(new fabric.Line(
        [-spec.width / 2, -spec.height / 2, spec.width / 2, spec.height / 2],
        { stroke: spec.color, strokeWidth: 2 }));
      parts.push(new fabric.Line(
        [-spec.width / 2, spec.height / 2, spec.width / 2, -spec.height / 2],
        { stroke: spec.color, strokeWidth: 2 }));
    }
    // 여과탱크 기호: 정수실 도면처럼 탱크 몸통에 가로 밴드 두 줄
    if (spec.symbol === "tank") {
      [-0.18, 0.18].forEach((f) => {
        parts.push(new fabric.Rect({
          width: spec.width * 0.78, height: spec.height * 0.12,
          fill: spec.color,
          originX: "center", originY: "center", top: spec.height * f,
        }));
      });
    }
    // 배관 콘솔 기호: 덕트 안 배관 2계통을 나타내는 점선 두 줄
    if (spec.symbol === "console") {
      [-1, 1].forEach((s) => {
        parts.push(new fabric.Line(
          [-spec.width / 2 + 5, (s * spec.height) / 6, spec.width / 2 - 5, (s * spec.height) / 6],
          { stroke: spec.color, strokeWidth: 1.5, strokeDashArray: [10, 6] }));
      });
    }
    // 2인 데스크 기호: 책상(상단 바) + 의자 2개
    if (spec.symbol === "desk2") {
      parts.push(new fabric.Rect({
        width: spec.width - 12, height: spec.height * 0.42,
        fill: spec.color, opacity: 0.75,
        originX: "center", originY: "center", top: -spec.height * 0.24,
      }));
      [-1, 1].forEach((s) => {
        parts.push(new fabric.Rect({
          width: 36, height: 32, rx: 7, ry: 7,
          fill: "#ffffff", stroke: spec.color, strokeWidth: 2,
          originX: "center", originY: "center",
          left: s * spec.width * 0.22, top: spec.height * 0.26,
        }));
      });
    }
    // 이송펌프 기호: Auto/Manual 펌프 원 두 개
    if (spec.symbol === "pump") {
      [-1, 1].forEach((s) => {
        parts.push(new fabric.Circle({
          radius: spec.height * 0.34,
          fill: "#ffffff", stroke: spec.color, strokeWidth: 2,
          originX: "center", originY: "center", left: s * spec.width * 0.24,
        }));
      });
    }
    parts.push(text);
    const grp = new fabric.Group(parts, {
      left: opts.left ?? Math.round(room.width / 2 - spec.width / 2),
      top: opts.top ?? Math.round(room.height / 2 - spec.height / 2),
      angle: opts.angle ?? 0,
    });
    grp.meta = {
      key,
      label: spec.label,
      type: spec.type,
      requiresWater: !!spec.requiresWater,
      isolationCapable: !!spec.isolationCapable,
    };
    canvas.add(grp);
    // 투석 침대 단독 추가 시 HD 번호 부여 (병상 유닛 내부 침대는 제외)
    if (key === "dialysis_bed" && !opts.inUnit) assignBedNumber(grp);
    applyBlueprintToObject(grp);
    if (!opts.silent) { canvas.setActiveObject(grp); canvas.requestRenderAll(); }
    return grp;
  }

  /* ───────────────── 병상 번호 (HD1, HD2, …) ───────────────── */
  /** 병상 번호 배지 텍스트 생성 (그룹 좌측 상단, 굵은 초록색) */
  function makeBedBadge(name, left, top) {
    const badge = new fabric.Text(name, {
      left, top, fontSize: 28, fontWeight: "bold", fill: "#1B5E20",
    });
    badge.meta = { key: "bed_badge" };
    return badge;
  }

  /** 병상 그룹에 순차 HD 번호를 부여하고 배지를 그룹에 포함 */
  function assignBedNumber(grp) {
    bedCounter += 1;
    const name = "HD" + bedCounter;
    grp.meta.name = name;
    grp.addWithUpdate(makeBedBadge(name, grp.left + 4, grp.top + 2));
    applyBlueprintToObject(grp); // 도면 모드 중이면 배지도 흑백 반영
    return name;
  }

  /** 그룹 안의 번호 배지 텍스트 찾기 */
  function findBedBadge(grp) {
    if (!grp.getObjects) return null;
    return grp.getObjects().find((c) => c.meta && c.meta.key === "bed_badge") ?? null;
  }

  function isBedObject(o) {
    return o.meta && ["dialysis_bed", "bed_unit"].includes(o.meta.key);
  }

  /**
   * 병상 번호 재정렬: (top 200cm 단위 행 → left 오름차순) 순서로
   * HD1부터 다시 부여하고 배지 텍스트를 갱신한다.
   */
  function renumberBeds() {
    const beds = getObjects().filter(isBedObject);
    beds.sort((a, b) => {
      const rowA = Math.floor(a.top / 200), rowB = Math.floor(b.top / 200);
      return rowA !== rowB ? rowA - rowB : a.left - b.left;
    });
    bedCounter = 0;
    beds.forEach((b) => {
      bedCounter += 1;
      b.meta.name = "HD" + bedCounter;
      const badge = findBedBadge(b);
      if (badge) { badge.set("text", b.meta.name); b.addWithUpdate(); }
      else b.addWithUpdate(makeBedBadge(b.meta.name, b.left + 4, b.top + 2)); // 배지가 없으면 새로 부착
    });
    canvas.requestRenderAll();
    return beds.length;
  }

  /**
   * 선택 객체 이름 변경.
   * 병상(dialysis_bed / bed_unit)은 meta.name(HD 번호)을 우선 갱신하고
   * 배지 텍스트를 다시 그린다. 그 외 객체는 meta.label + 내부 라벨 텍스트 갱신.
   */
  function renameSelected(name) {
    const o = canvas.getActiveObject();
    if (!o || !o.meta || !name) return false;
    if (isBedObject(o)) {
      o.meta.name = name;
      const badge = findBedBadge(o);
      if (badge) { badge.set("text", name); o.addWithUpdate(); }
    } else {
      o.meta.label = name;
      if (o.getObjects) {
        const txt = o.getObjects().find((c) => c.type === "text" && (!c.meta || c.meta.key !== "bed_badge"));
        if (txt) { txt.set("text", name); o.addWithUpdate(); }
      }
    }
    canvas.requestRenderAll();
    return true;
  }

  /* ───────────────── 그룹화 / 해제 ───────────────── */
  function groupSelection() {
    const sel = canvas.getActiveObject();
    if (!sel || sel.type !== "activeSelection") return false;
    const memberMeta = sel.getObjects().map((o) => o.meta).filter(Boolean);
    const grp = sel.toGroup();
    grp.meta = {
      key: "unit_group",
      label: "장비 그룹",
      // 그룹 안에 정수 필요 장비가 있으면 그룹 자체도 정수 필요로 취급
      requiresWater: memberMeta.some((m) => m.requiresWater),
      members: memberMeta.map((m) => m.key),
    };
    canvas.requestRenderAll();
    return true;
  }

  function ungroupSelection() {
    const sel = canvas.getActiveObject();
    if (!sel || sel.type !== "group" || !sel.meta || sel.meta.key !== "unit_group") return false;
    sel.toActiveSelection();
    canvas.requestRenderAll();
    return true;
  }

  /* ───────────────── 배관 그리기 (급수/배수) ───────────────── */
  /** 배관 그리기 모드 토글. 같은 타입을 다시 누르면 종료, 다른 타입이면 전환. */
  function togglePipeMode(type = "inlet") {
    if (pipeMode && pipeType === type) {
      finishPipe(); // pipeMode = false 처리 포함
    } else {
      if (pipeMode) finishPipe(); // 그리던 다른 타입 배관은 완료 처리
      pipeMode = true;
      pipeType = type;
    }
    canvas.defaultCursor = pipeMode ? "crosshair" : "default";
    return pipeMode;
  }

  function addPipePoint(p) {
    const snap = snapSize || 10;
    pipePoints.push({
      x: Math.round(p.x / snap) * snap,
      y: Math.round(p.y / snap) * snap,
    });
  }

  function drawPipePreview(cursor) {
    if (pipePreview) canvas.remove(pipePreview);
    const spec = pipeTypes[pipeType] ?? pipeTypes.inlet;
    pipePreview = new fabric.Polyline([...pipePoints, cursor], {
      // 미리보기는 해당 배관 색상, 실선 타입도 점선으로 표시해 '작성 중'임을 구분
      fill: "", stroke: spec.color, strokeWidth: 6,
      strokeDashArray: spec.dash ? [...spec.dash] : [15, 10],
      selectable: false, evented: false,
    });
    canvas.add(pipePreview);
    canvas.requestRenderAll();
  }

  function finishPipe() {
    if (pipePreview) { canvas.remove(pipePreview); pipePreview = null; }
    if (pipePoints.length >= 2) addPipe(pipePoints, pipeType);
    pipePoints = [];
    pipeMode = false;
    canvas.defaultCursor = "default";
  }

  /** 배관 추가 — 급수(inlet, 파란 실선) / 배수(drain, 갈색 점선) */
  function addPipe(points, type = "inlet") {
    const spec = pipeTypes[type] ?? pipeTypes.inlet;
    const line = new fabric.Polyline(points.map((p) => ({ x: p.x, y: p.y })), {
      fill: "", stroke: spec.color, strokeWidth: 6,
      strokeDashArray: spec.dash ? [...spec.dash] : null,
    });
    // 시작점 옆 소형 라벨 (IN / DR) — 배관과 한 그룹으로 묶어 함께 이동
    const tag = new fabric.Text(type === "drain" ? "DR" : "IN", {
      fontSize: 16, fontWeight: "bold", fill: spec.color,
      left: points[0].x + 6, top: points[0].y - 24,
    });
    const grp = new fabric.Group([line, tag]);
    grp.meta = { key: "pipe", pipeType: type, label: spec.label };
    canvas.add(grp);
    return grp;
  }

  /* ───────────────── 문(개구부) 추가 ─────────────────
   * 건축 도면 기호로 렌더링. 가로 방향(문 폭 = x축)으로 그리고
   * 사용자가 회전(angle)으로 벽에 맞춘다. */
  function addDoor(key, opts = {}) {
    const spec = doorData[key];
    if (!spec) return null;

    // 공통: 개구부(벽 절개) 표현 — 흰색 바탕 사각형
    const parts = [
      new fabric.Rect({
        left: 0, top: -7, width: spec.width, height: 14,
        fill: "#ffffff", stroke: "#90a4ae", strokeWidth: 1,
      }),
    ];

    const leaf = (coords) =>
      new fabric.Line(coords, { stroke: "#37474F", strokeWidth: 4 });
    const arc = (path) =>
      new fabric.Path(path, {
        fill: "", stroke: "#78909C", strokeWidth: 1.5, strokeDashArray: [6, 5],
      });

    if (key === "swing_door") {
      // 경첩 (0,0), 문짝 + 1/4 원호 개폐 궤적
      parts.push(leaf([0, 0, 0, -90]));
      parts.push(arc("M 0 -90 A 90 90 0 0 1 90 0"));
    } else if (key === "double_swing_door") {
      // 좌(경첩 x=0)·우(경첩 x=180) 대칭 두 짝
      parts.push(leaf([0, 0, 0, -90]));
      parts.push(arc("M 0 -90 A 90 90 0 0 1 90 0"));
      parts.push(leaf([180, 0, 180, -90]));
      parts.push(arc("M 180 -90 A 90 90 0 0 0 90 0"));
    } else if (key === "auto_door") {
      // 슬라이딩 패널 2장 + AUTO 표기
      parts.push(new fabric.Rect({
        left: 2, top: -4, width: 86, height: 8,
        fill: "#B3E5FC", stroke: spec.color, strokeWidth: 2,
      }));
      parts.push(new fabric.Rect({
        left: 92, top: -4, width: 86, height: 8,
        fill: "#B3E5FC", stroke: spec.color, strokeWidth: 2,
      }));
      parts.push(new fabric.Text("AUTO", {
        fontSize: 16, fill: spec.color,
        originX: "center", left: 90, top: -26,
      }));
    } else if (key === "sliding_door") {
      // 미닫이: 패널 + 겹침 패널
      parts.push(new fabric.Rect({
        left: 0, top: -10, width: 72, height: 8,
        fill: "#CFD8DC", stroke: spec.color, strokeWidth: 2,
      }));
      parts.push(new fabric.Rect({
        left: 54, top: 2, width: 66, height: 8,
        fill: "#ECEFF1", stroke: spec.color, strokeWidth: 2,
      }));
    }

    const grp = new fabric.Group(parts, {
      left: opts.left ?? room.width / 2 - spec.width / 2,
      top: opts.top ?? room.height - 7,
      angle: opts.angle ?? 0,
    });
    grp.meta = { key, label: spec.label, isDoor: true };
    canvas.add(grp);
    applyBlueprintToObject(grp);
    if (!opts.silent) { canvas.setActiveObject(grp); canvas.requestRenderAll(); }
    return grp;
  }

  /* ───────────────── 자동 배치 ─────────────────
   * 입력된 병실 크기에 맞춰 정수실·창고·탈의실·화장실·간호사실·격리실을
   * 벽면에 배치하고, 남은 면적에 병상 유닛(침대+투석기)을 규격 간격으로
   * 채운 뒤 정수 배관 동선을 그린다. */
  function autoLayout() {
    beginBulk();
    const W = room.width, H = room.height;
    newRoomKeepBackground(W, H);

    const M = 10; // 벽 내측 여유
    const placed = [];

    // ① 좌측 서비스 존: 정수실(상) → 창고(하)
    placed.push(addEquipment("water_treatment", { left: M, top: M, silent: true }));
    placed.push(addEquipment("storage", { left: M, top: M + 410, silent: true }));

    // ② 하단: 탈의실 → 화장실 → 간호사실(중앙)
    addEquipment("changing_room", { left: M, top: H - 260, silent: true });
    addEquipment("toilet", { left: 220, top: H - 210, silent: true });
    const nurseX = Math.max(390, Math.round((W - 300) / 2 / 10) * 10);
    addEquipment("nurse_station", { left: nurseX, top: H - 210, silent: true });

    // ③ 우측 상단: 감염관리 격리실 (+ 격리 병상)
    const isoW = equipmentData.isolation_room.width;
    const hasIsolation = W >= 320 + isoW + 400;
    let isoBed = null;
    if (hasIsolation) {
      addEquipment("isolation_room", { left: W - isoW - M, top: M, silent: true });
      isoBed = addBedUnit(W - isoW - M + 60, M + 40, true);
    }

    // ④ 병상 유닛 자동 채움 (침대 머리맡이 위쪽 벽을 향하는 상단 열)
    const bed = equipmentData.dialysis_bed;
    const unitW = bed.width + 60;                     // 침대 + 측면 투석기 폭
    const pitch = unitW + MEDICAL_RULES.MIN_BED_GAP_CM + 20; // 배치 피치
    const rowX0 = 320 + 40;                           // 서비스 존 우측부터
    const rowX1 = W - (hasIsolation ? isoW + 40 : 30);
    const topBeds = fillBedRow(rowX0, rowX1, M + 30, pitch);
    if (isoBed) topBeds.push(isoBed); // 배관 주행이 격리 병상까지 이어지도록 포함

    // ⑤ 공간이 충분하면 하단 열 추가 (중앙 통로 200cm 확보)
    let bottomBeds = [];
    const bottomRowY = H - 260 - bed.height - 40;
    if (bottomRowY - (M + 30 + bed.height) >= 200) {
      bottomBeds = fillBedRow(rowX0, W - 30, bottomRowY, pitch);
    }

    // ⑥ 정수 배관 동선: 정수실 → 상단 벽 주행 → 각 병상 분기
    drawPipeRuns(topBeds, bottomBeds, bottomRowY);

    // ⑦ 출입문 자동 배치 (여닫이문은 모두 실 내부로 열림)
    addDoor("auto_door", { left: nurseX - 220, top: H - 4, silent: true });     // 주 출입구 자동문
    addDoor("swing_door", { left: 120, top: H - 170, angle: 180, silent: true }); // 탈의실 문 (위쪽 변 → 안쪽)
    addDoor("swing_door", { left: 330, top: H - 120, angle: 180, silent: true }); // 화장실 문 (위쪽 변 → 안쪽)
    addDoor("swing_door", { left: 324, top: 60, angle: 90, silent: true });     // 정수실 문 (오른쪽 벽 → 안쪽)
    addDoor("swing_door", { left: 224, top: 460, angle: 90, silent: true });    // 창고 문 (오른쪽 벽 → 안쪽)
    if (hasIsolation) {
      addDoor("sliding_door", { left: W - 300, top: 306, silent: true });      // 격리실 하단 미닫이문
    }

    canvas.discardActiveObject();
    canvas.requestRenderAll();
    endBulk();
    return { beds: topBeds.length + bottomBeds.length };
  }

  function fillBedRow(x0, x1, y, pitch) {
    const beds = [];
    for (let x = x0; x + equipmentData.dialysis_bed.width + 60 <= x1; x += pitch) {
      beds.push(addBedUnit(x, y, false));
    }
    return beds;
  }

  /** 침대 + 투석기 + 모니터를 폭 moduleWidth의 '병상 모듈'로 생성 (HD 번호 자동 부여)
   *  모듈 경계 프레임이 그룹 폭을 고정하므로 모듈끼리 붙여서(피치=모듈 폭) 배치할 수 있다.
   *  headDown=true면 머리맡(투석기 쪽)이 아래 — 콘솔 양면 배치의 위쪽 행에 사용 */
  function addBedUnit(x, y, isolated, headDown = false) {
    const mw = moduleWidth;
    // 모듈 경계: 침대 + 장비 존을 하나의 타일로 묶는 점선 프레임
    const frame = new fabric.Rect({
      left: x, top: y, width: mw, height: 220,
      fill: "rgba(96,125,139,0.05)",
      stroke: "#90A4AE", strokeWidth: 1.5, strokeDashArray: [8, 6],
    });
    frame.meta = { key: "module_frame", label: "모듈 경계" };
    canvas.add(frame);
    // 침대는 유닛 내부이므로 inUnit으로 단독 HD 번호 부여를 건너뛰고, 유닛에 번호를 준다
    const bed = addEquipment("dialysis_bed", { left: x, top: y, silent: true, inUnit: true });
    const mx = x + 120 + Math.max(3, Math.round((mw - 120 - 50) / 2)); // 장비 존 중앙
    const machine = addEquipment("dialysis_machine", { left: mx, top: headDown ? y + 150 : y, silent: true });
    const sel = new fabric.ActiveSelection([frame, bed, machine], { canvas });
    const grp = sel.toGroup();
    grp.meta = {
      key: "bed_unit",
      label: isolated ? "격리 병상 유닛" : "병상 유닛",
      requiresWater: true,
      isolationCapable: true,
      isolated,
      headDown, // true = 머리맡 아래(발쪽 위) — 발쪽-벽 이격 검증에 사용
      members: ["module_frame", "dialysis_bed", "dialysis_machine"],
    };
    assignBedNumber(grp);
    canvas.requestRenderAll();
    return grp;
  }

  function drawPipeRuns(topBeds, bottomBeds, bottomRowY) {
    const wt = getObjects().find((o) => o.meta.key === "water_treatment");
    if (!wt || !topBeds.length) return;
    const CD = consoleDepth;
    const DRAIN_OFF = Math.min(14, Math.max(6, Math.round(CD * 0.3))); // 배수 평행 간격(콘솔 안)
    const drainOf = (pts) => pts.map((p) => ({ x: p.x, y: p.y + DRAIN_OFF })); // 배수 평행선 좌표
    // 상단 열 머리맡 배관 콘솔 + 콘솔 내부 주행 높이
    const topRow = topBeds.filter((b) => b.top < 100); // 격리 병상 제외한 상단 열
    let runY = 20;
    if (topRow.length) {
      const cx0 = Math.min(...topRow.map((b) => b.left)) - 15;
      const cx1 = Math.max(...topRow.map((b) => b.left + b.width)) + 15;
      const cTop = Math.max(2, topRow[0].top - CD - 3);
      addEquipment("bed_console", { left: cx0, top: cTop, width: cx1 - cx0, silent: true });
      runY = cTop + Math.max(5, Math.round(CD * 0.35));
    }
    const startX = wt.left + wt.width;
    const endX = topBeds[topBeds.length - 1].left + topBeds[topBeds.length - 1].width;
    // 상단 주행선: 급수(파란 실선) + 평행 배수(갈색 점선) 2계통
    const run1 = [{ x: startX, y: wt.top + 100 }, { x: startX + 20, y: wt.top + 100 },
                  { x: startX + 20, y: runY }, { x: endX, y: runY }];
    addPipe(run1, "inlet");
    addPipe(drainOf(run1), "drain");
    topBeds.forEach((b) => {
      const px = b.left + b.width - 30;
      addPipe([{ x: px, y: runY }, { x: px, y: b.top + 20 }], "inlet");
    });
    if (bottomBeds.length) {
      // 하단 열 머리맡 배관 콘솔
      const cx0b = Math.min(...bottomBeds.map((b) => b.left)) - 15;
      const cx1b = Math.max(...bottomBeds.map((b) => b.left + b.width)) + 15;
      addEquipment("bed_console", { left: cx0b, top: bottomRowY - CD - 3, width: cx1b - cx0b, silent: true });
      const dropX = startX + 20;
      const runY2 = bottomRowY - CD - 3 + Math.max(5, Math.round(CD * 0.35));
      const endX2 = bottomBeds[bottomBeds.length - 1].left + bottomBeds[bottomBeds.length - 1].width;
      const run2 = [{ x: dropX, y: runY }, { x: dropX, y: runY2 }, { x: endX2, y: runY2 }];
      addPipe(run2, "inlet");
      addPipe(drainOf(run2), "drain");
      bottomBeds.forEach((b) => {
        const px = b.left + b.width - 30;
        addPipe([{ x: px, y: runY2 }, { x: px, y: b.top + 20 }], "inlet");
      });
    }
  }

  /* ───────────────── 흑백 도면(청사진) 모드 ─────────────────
   * 배치 객체를 건축 도면 스타일(흰 바탕 + 검정 선/글자)로 전환한다.
   * 최초 전환 시 _origFill/_origStroke에 원래 색을 저장해 복원에 사용.
   * 배관(급수/배수)은 계통 구분이 필요하므로 원래 색을 유지한다. */
  function eachNode(o, fn) {
    fn(o);
    if (o.getObjects) o.getObjects().forEach((c) => eachNode(c, fn));
  }

  function paintBlueprintNode(node) {
    if (node._origFill === undefined) node._origFill = node.fill ?? null;
    if (node._origStroke === undefined) node._origStroke = node.stroke ?? null;
    if (node.type === "text") {
      node.set("fill", "#000000");
    } else if (node.type !== "group") {
      if (node.fill && node.fill !== "transparent") node.set("fill", "#ffffff");
      if (node.stroke) node.set("stroke", "#000000");
    }
    node.dirty = true;
  }

  function restoreNode(node) {
    if (node._origFill !== undefined) node.set("fill", node._origFill);
    if (node._origStroke !== undefined) node.set("stroke", node._origStroke);
    node.dirty = true;
  }

  /** 개별 객체에 현재 도면 모드를 반영 (새로 추가되는 객체용) */
  function applyBlueprintToObject(o) {
    if (!blueprintMode) return;
    if (o.meta && o.meta.key === "pipe") return; // 배관은 원래 색 유지
    eachNode(o, paintBlueprintNode);
  }

  /** 흑백 도면 모드 켜기/끄기 */
  function setBlueprintMode(on) {
    blueprintMode = !!on;
    getObjects().forEach((o) => {
      if (o.meta && o.meta.key === "pipe") return; // 배관은 원래 색 유지
      eachNode(o, blueprintMode ? paintBlueprintNode : restoreNode);
    });
    canvas.requestRenderAll();
    return blueprintMode;
  }

  /* ───────────────── 실별 기본 오브젝트 배치 ─────────────────
   * 각 실의 용도에 맞는 집기·위생기구를 실 내부에 기본 배치한다.
   * put()은 실 크기를 벗어나면 생략하고, 문 개폐 구역(doorZones)과 겹치면
   * 좌우 반전 위치로 회피 — 오브젝트가 문 입구를 막지 않는다. */
  function populateRoom(key, x, y, w, h, doorZones = []) {
    const hitsDoor = (dx, dy, ow, oh) => doorZones.some((z) =>
      x + dx < z.x1 && x + dx + ow > z.x0 && y + dy < z.y1 && y + dy + oh > z.y0);
    const put = (k, dx, dy, opts = {}) => {
      const s = equipmentData[k];
      if (!s) return null;
      const ow = opts.width ?? s.width, oh = opts.height ?? s.height;
      let px = dx;
      if (hitsDoor(px, dy, ow, oh)) px = w - ow - dx; // 문과 겹치면 반대편으로
      if (px < 8 || px + ow > w - 8 || dy + oh > h - 8 || hitsDoor(px, dy, ow, oh)) return null;
      return addEquipment(k, { left: x + px, top: y + dy, silent: true, ...opts });
    };
    switch (key) {
      case "nurse_room": // 간호사실: 회의 테이블 + 락커 2열 (탈의·휴게)
        put("counter_desk", 15, 20, { width: Math.min(w - 40, 200) });
        put("cabinet", 15, h - 57);
        put("cabinet", 145, h - 57);
        break;
      case "nurse_station": { // 2인 데스크 × (좌석/2), 개방면(상단)을 향해 배치
        const desks = Math.min(4, Math.ceil(stationSeats / 2)); // 최대 8석 = 4유닛
        for (let i = 0; i < desks; i++) {
          const col = i % 2, rowI = Math.floor(i / 2);
          put("station_desk2", 15 + col * 172, 12 + rowI * 108);
        }
        put("cabinet", 15, h - 57);
        break;
      }
      case "changing_room": // 락커 2열
        put("cabinet", 12, 15);
        put("cabinet", 12, 70);
        break;
      case "toilet":
        put("toilet_bowl", w - 55, h - 85);
        put("washbasin", 12, h - 60);
        break;
      case "storage":
      case "linen_room": // 벽면 선반
        put("shelf", 12, 15);
        put("shelf", 12, 65);
        break;
      case "waiting_area": // 대기 의자 열
        put("chair_wait", 15, 15);
        put("chair_wait", 15, 75);
        put("chair_wait", 180, 15);
        put("chair_wait", 180, 75);
        break;
      case "pharmacy_room":
      case "treatment_room":
      case "consult_room":
      case "office_room": // 작업대 + 수납
        put("counter_desk", 12, 12, { width: Math.min(w - 30, 180) });
        put("cabinet", 12, h - 57);
        break;
      case "laundry_room":
      case "clean_room":
      case "waste_room": // 세척 싱크 (+선반)
        put("sink", 12, 12);
        put("shelf", 12, h - 52);
        break;
      case "isolation_room": // 감염관리 손세정대
        put("washbasin", w - 70, h - 60);
        break;
      case "water_treatment": // 정수실 내부 자동 모델링 — 시공 도면의 처리 순서 반영
        // ① 원수 인입 + 이송펌프 (상단)
        put("raw_water_inlet", 12, 14);
        put("pump_unit", 42, 12);
        put("main_panel", w - 115, 12);
        // ② 전처리 탱크 3연: Multimedia → Softner → Carbon (처리 순서)
        put("multimedia_filter", 15, 70);
        put("softner_filter", 92, 70);
        put("carbon_filter", 169, 70);
        // ③ 5μ 필터 + 제어반
        put("filter_5u", 15, 150);
        put("control_box", w - 50, 100);
        // ④ RO 본체 (하단) + 배수
        put("cwp106h", 12, h - 200, { width: Math.min(w - 30, 220) });
        put("cwp66", w - 145, h - 95);
        put("heating_system", 12, h - 95, { width: Math.min(150, w - 170), height: 80 });
        put("drain_natural", Math.round(w / 2) - 10, Math.round(h / 2));
        break;
    }
  }

  /* ───────────────── N.S 아일랜드 (U자형 개방 카운터) ─────────────────
   * 참고 도면의 간호 스테이션: 병상 필드 안에 독립 배치된 U자 카운터로,
   * 개방면이 병상 쪽을 향해 모든 병상 열을 관찰한다. 내부에 2인 데스크
   * 유닛(stationSeats/2 조)을 배치한다. */
  function addStationIsland(x, y, seats) {
    const desks = Math.min(4, Math.ceil((seats ?? stationSeats) / 2));
    const perRow = desks > 2 ? 2 : 1;
    const rows = Math.ceil(desks / perRow);
    const bar = 35;
    const w = 70 + perRow * 172;
    const h = bar + 25 + rows * 112;
    const col = "#FF9800";
    const mk = (left, top, bw, bh) => new fabric.Rect({
      left, top, width: bw, height: bh, rx: 12, ry: 12,
      fill: col + "55", stroke: col, strokeWidth: 3,
    });
    const parts = [
      mk(0, 0, w, bar),          // 상부 바 (닫힌 면)
      mk(0, 0, bar, h),          // 좌측 팔
      mk(w - bar, 0, bar, h),    // 우측 팔 — 아래(병상 필드)가 개방면
      new fabric.Text("N.S", {
        fontSize: 30, fontWeight: "bold", fill: "#E65100",
        left: w / 2, top: 4, originX: "center",
      }),
    ];
    const grp = new fabric.Group(parts, { left: x, top: y });
    grp.meta = { key: "nurse_station", label: "간호 스테이션 (N.S)", type: "room" };
    canvas.add(grp);
    applyBlueprintToObject(grp);
    // U자 안쪽 2인 데스크 유닛 — 개방면(아래)을 향해 착석
    for (let i = 0; i < desks; i++) {
      const ci = i % perRow, ri = Math.floor(i / perRow);
      addEquipment("station_desk2", { left: x + 42 + ci * 172, top: y + bar + 8 + ri * 112, silent: true });
    }
    return { grp, w, h };
  }

  /* ───────────────── Auto Modeling: 랜덤 변형 자동 설계 ─────────────────
   * 선택한 시설 + 목표 병상 대수를 받아, 시드 난수로 배치 변수(서비스 존
   * 방향·통로 폭·병상 간격·시설 순서)를 바꿔가며 매번 다른 도면을 생성한다.
   * 병상은 목표 대수까지 최대한 채우고, 통로 150cm 이상·병상 간격 규격을
   * 지키는 "편의성 우선" 행 배치를 사용한다. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function autoModel(opts = {}) {
    const target = Math.max(1, Math.round(opts.targetBeds ?? 20));
    const chosen = (opts.facilities ?? []).filter((k) => equipmentData[k]);
    const rng = mulberry32((opts.seed ?? 1) >>> 0);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const shuffle = (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    beginBulk();
    const W = room.width, H = room.height;
    newRoomKeepBackground(W, H);
    const M = 10;

    // ── 시설 분류: 실별 특성에 따라 내부(환자 접근)/외부(후방 지원) 배치 ──
    // 외부(back-of-house) 실: 소음·오염·설비 계열 → 측면 기술 밴드(외벽 쪽)
    // 내부(patient-facing) 실: 환자가 드나드는 실 → 하단 환자 밴드(출입구 쪽)
    // 참고 도면처럼 직원 지원실(간호사실·상담실·과장실)도 후방 블록에 둔다 —
    // 환자 프런트 밴드는 환자가 쓰는 실만 남겨 동선이 섞이지 않는다
    const TECH = ["water_treatment", "storage", "linen_room", "laundry_room",
                  "waste_room", "clean_room", "core",
                  "nurse_room", "consult_room", "office_room"];
    const techSide = pick(["left", "right"]); // 변형 포인트 ①: 서비스 존 방향
    const hasWT = chosen.includes("water_treatment");
    const hasIso = chosen.includes("isolation_room");
    // 참고 도면 분석 ①: 외부 밴드는 위(청결: 코어·창고·린넨)에서
    // 아래(오염: 기구세척·세탁·오물) 순으로 적층 — 오염 계열은 소음원인
    // 정수실과 함께 하단 코너에 모여 청결 동선과 분리되고 외부 반출이 쉽다.
    // 위(직원 지원·청결) → 아래(오염·설비) 순. 오염 계열이 정수실과 하단 코너에 모인다
    const TECH_ORDER = {
      office_room: -3, consult_room: -2, nurse_room: -1,
      core: 0, storage: 1, linen_room: 2, clean_room: 3, laundry_room: 4, waste_room: 5,
    };
    const techKeys = chosen.filter((k) => TECH.includes(k) && k !== "water_treatment")
      .sort((a, b) => (TECH_ORDER[a] ?? 9) - (TECH_ORDER[b] ?? 9));
    // 참고 도면 분석 ②: N.S는 병상 필드 안 'U자 아일랜드'로 독립 배치(별도 처리),
    // 간호처치실·조제실은 N.S와 같은 동선 쪽 끝에 인접시킨다.
    // 환자 밴드는 안쪽(직원 지원: 상담·과장)→환자 프런트(화장실→탈의→대기)→
    // 동선 쪽 끝(처치→조제) 순 — 환자 동선(출입구→대기→탈의→병상)과
    // 직원 동선(N.S↔조제/처치)이 교차하지 않는다.
    const hasNS = chosen.includes("nurse_station");
    // 환자 프런트(화장실·탈의·대기) → 동선 쪽 끝(간호처치실·조제실, N.S와 같은 복도)
    const PATIENT_ORDER = { toilet: 3, changing_room: 4, waiting_area: 5, treatment_room: 6, pharmacy_room: 7 };
    const patientKeys = shuffle(chosen.filter((k) =>
      !TECH.includes(k) && !["isolation_room", "water_treatment", "nurse_station"].includes(k)))
      .sort((a, b) => (PATIENT_ORDER[a] ?? 0) - (PATIENT_ORDER[b] ?? 0));

    // ── 부속시설 : 병상 필드 ≈ 1:1 면적 배분 — 실 크기를 배율 k로 확대 ──
    const allRoomKeys = [...techKeys, ...(hasWT ? ["water_treatment"] : []),
                         ...patientKeys, ...(hasIso ? ["isolation_room"] : [])];
    const baseArea = allRoomKeys.reduce((s, key) => s + equipmentData[key].width * equipmentData[key].height, 0);
    const maxTechW0 = Math.max(0, ...techKeys.map((key) => equipmentData[key].width),
                               hasWT ? equipmentData.water_treatment.width : 0);
    const maxPatH0 = Math.max(250, ...patientKeys.map((key) => equipmentData[key].height));
    let kScale = baseArea > 0 ? Math.sqrt((W * H * 0.5) / baseArea) : 1;
    kScale = Math.max(1, Math.min(kScale, (W * 0.35) / maxTechW0, (H * 0.4) / maxPatH0));
    // 확대 배율 상한: 선택한 실이 모두 들어가도록 제한한다
    // (세로) 후방 밴드 실 높이 합 + 환자 밴드 깊이 ≤ 병실 높이
    const sumTechH = [...techKeys, ...(hasWT ? ["water_treatment"] : [])]
      .reduce((s, key) => s + equipmentData[key].height, 0);
    if (sumTechH + maxPatH0 > 0) {
      const avail = H - M * 2 - 10 * (techKeys.length + 2);
      kScale = Math.max(1, Math.min(kScale, avail / (sumTechH + maxPatH0)));
    }
    // (가로) 환자 밴드 실 폭 합 + 후방 밴드 폭 + 주 동선 ≤ 병실 폭
    const sumPatW = patientKeys.reduce((s, key) => s + equipmentData[key].width, 0);
    if (sumPatW + maxTechW0 > 0) {
      const availW = W - M * 2 - 10 * (patientKeys.length + 1) - Math.max(120, Math.round(opts.passage ?? 150));
      kScale = Math.max(1, Math.min(kScale, availW / (sumPatW + maxTechW0)));
    }
    const sdim = (v) => Math.round((v * kScale) / 10) * 10; // 10cm 단위로 스케일

    // ── 기술 밴드: 측면 벽 세로 적층 (가로 폭 통일) ──
    // 조건 ②: 정수장치는 소음원이므로 병상 밀집 구역(상단 열)에서 가장 먼
    // 밴드 최하단 코너에 배치한다.
    const colW = maxTechW0 ? sdim(maxTechW0) : 0;
    const patientBandH = sdim(maxPatH0);
    const TECH_AISLE = 130; // 후방 밴드 두 열 사이 내부 복도(1300mm)
    // 후방 실 높이 합이 한 열에 안 들어가면 2열 구성 (참고 도면의 후방 블록)
    const bandAvailH = H - patientBandH - M * 2 - 10;
    const techNeedH = [...techKeys, ...(hasWT ? ["water_treatment"] : [])]
      .reduce((s, key) => s + sdim(equipmentData[key].height) + 10, 0);
    const fieldNeedW = 130 + Math.max(120, Math.round(opts.passage ?? 150)) + moduleWidth * 3;
    const techCols = (techNeedH > bandAvailH && colW &&
                      W - (colW * 2 + TECH_AISLE) - M * 2 >= fieldNeedW) ? 2 : 1;
    const techBandW = colW ? colW * techCols + TECH_AISLE * (techCols - 1) : 0;
    {
      const tx = techSide === "left" ? M : W - techBandW - M;
      // 열(column) 좌표: col 0 = 외벽 쪽, col 1 = 안쪽. 두 열 사이는 내부 복도.
      const colX = (c) => techSide === "left"
        ? tx + c * (colW + TECH_AISLE)
        : tx + techBandW - colW - c * (colW + TECH_AISLE);
      // 문 앵커 보정: angle 90은 앵커 기준 왼쪽·아래로, angle 270은 오른쪽·위로
      // 그려진다(fabric 실측). 스윙 범위가 자기 실 내부에 머물도록 보정한다.
      // 각 실의 문은 자기 열에서 복도(또는 병상 필드) 쪽 변에 단다.
      const innerDoor = (c, ty) => techSide === "left"
        ? addDoor("swing_door", { left: colX(c) + colW + 14, top: ty + 40, angle: 90, silent: true })
        : addDoor("swing_door", { left: colX(c) - 7, top: ty + 130, angle: 270, silent: true });
      const outerDoor = (ty) => techSide === "left"
        ? addDoor("swing_door", { left: colX(0) - 7, top: ty + 130, angle: 270, silent: true })
        : addDoor("swing_door", { left: colX(0) + colW + 7, top: ty + 40, angle: 90, silent: true });
      // 문 개폐 구역(오브젝트 배치 금지): 안쪽 문/바깥쪽 문 스윙 범위
      const innerDoorZone = (c, ty) => techSide === "left"
        ? { x0: colX(c) + colW - 95, x1: colX(c) + colW + 5, y0: ty + 30, y1: ty + 140 }
        : { x0: colX(c) - 5, x1: colX(c) + 100, y0: ty + 30, y1: ty + 140 };
      const outerDoorZone = (ty) => techSide === "left"
        ? { x0: colX(0) - 5, x1: colX(0) + 100, y0: ty + 30, y1: ty + 140 }
        : { x0: colX(0) + colW - 95, x1: colX(0) + colW + 5, y0: ty + 30, y1: ty + 140 };

      // 정수실: 외벽 열(col 0) 맨 아래 — 환자에게서 가장 먼 코너
      let wtTop = H - patientBandH - M - 10;
      if (hasWT) {
        const wtH = sdim(equipmentData.water_treatment.height);
        wtTop = H - patientBandH - M - 10 - wtH;
        addEquipment("water_treatment", { left: colX(0), top: wtTop, width: colW, height: wtH, silent: true });
        innerDoor(0, wtTop);
        populateRoom("water_treatment", colX(0), wtTop, colW, wtH, [innerDoorZone(0, wtTop)]);
      }
      // 나머지 후방 실은 정수실 위에서부터 아래→위로 적층하고,
      // 열이 차면 안쪽 열(col 1)로 넘어간다 — 두 열 사이는 내부 복도.
      // 오염 계열(오물·세탁·세척)이 정수실과 하단 코너에 모이고,
      // 청결·직원 계열(린넨·창고·코어·간호사실·상담·과장)이 위로 간다.
      const colTops = [wtTop - 10, H - patientBandH - M - 10];
      [...techKeys].reverse().forEach((key) => { // waste → … → office 순으로 아래부터
        const h = sdim(equipmentData[key].height);
        let c = 0;
        if (colTops[0] - h < M) c = 1;           // 외벽 열이 차면 안쪽 열로
        if (colTops[c] - h < M) return;          // 두 열 모두 부족하면 생략
        colTops[c] -= h;
        const ty2 = colTops[c];
        addEquipment(key, { left: colX(c), top: ty2, width: colW, height: h, silent: true });
        innerDoor(c, ty2);
        // 조건 ⑥: 오물처리실은 내부(복도) + 외부(외벽) 양방향 출구
        const zones = [innerDoorZone(c, ty2)];
        if (key === "waste_room" && c === 0) {
          const oy = ty2 + Math.min(120, h - 130);
          outerDoor(oy);
          zones.push(outerDoorZone(oy));
        }
        populateRoom(key, colX(c), ty2, colW, h, zones); // 실별 기본 오브젝트 (문 앞 회피)
        colTops[c] -= 10;
      });
      // 두 열 사이 내부 복도 표시 (후방 지원 동선)
      if (techCols > 1) {
        const zx = techSide === "left" ? tx + colW + 2 : tx + colW + 2;
        const zone = new fabric.Rect({
          left: zx, top: M + 10, width: TECH_AISLE - 4, height: H - patientBandH - M * 2 - 10,
          fill: "rgba(158,158,158,0.10)", stroke: "#9E9E9E",
          strokeWidth: 1.5, strokeDashArray: [12, 10],
          selectable: false, evented: false,
        });
        zone.meta = { key: "annotation", label: "후방 복도" };
        canvas.add(zone);
      }
    }

    // ── 주 출입구 + 주 동선 통로: 병상 필드의 먼쪽 가장자리 ──
    // 동선-배관 분리 설계: 주 동선을 필드 '가장자리'에 두어 병상 열·콘솔·
    // 배관 주행선이 사람 이동 통로를 가로지르지 않게 한다
    const CD = consoleDepth;                                  // 배관 콘솔 두께
    const aisle = Math.min(400, Math.max(100, Math.round(opts.passage ?? 150))); // 마주보는 장비 사이 통로(기본 1500mm)
    // 참고 도면 분석 ③: 모든 출입문을 통과하면 바로 '통로'가 되도록
    // 기술 밴드 문 앞 세로 복도와 환자 밴드 문 앞 가로 복도(각 130cm)를
    // 병상 금지 구역으로 확보한다 (도면의 동선 화살표 구간에 해당)
    const DOOR_CLEAR = 130;
    const fieldX0 = techSide === "left" ? techBandW + M + DOOR_CLEAR : M + 30;
    const fieldX1 = techSide === "right" ? W - techBandW - M - DOOR_CLEAR : W - 30;
    const fieldY1 = H - patientBandH - M - DOOR_CLEAR; // 환자 밴드 문 앞 복도 위까지
    const cw = Math.max(120, aisle);
    const corridor = techSide === "left"
      ? { x0: fieldX1 - cw, x1: fieldX1 }   // 기술 밴드 반대편 가장자리
      : { x0: fieldX0, x1: fieldX0 + cw };
    const doorW = 180;
    const ex = Math.round((corridor.x0 + (cw - doorW) / 2) / 10) * 10;
    addDoor("auto_door", { left: ex, top: H - 4, silent: true });

    // ── 환자 밴드: 하단 벽 가로 배치 (세로 깊이 통일) ──
    // 참고 도면 순서: 안쪽(직원 지원) → 환자 프런트(화장실·탈의·대기) →
    // 동선 쪽 끝(간호처치실·조제실) — 처치/조제실이 N.S와 같은 동선에 붙는다
    {
      const bandX0 = techSide === "left" ? techBandW + 40 : corridor.x1 + 10;
      const xMax = techSide === "left" ? corridor.x0 - 10 : W - techBandW - 40;
      // techSide=right면 출입구(왼쪽)부터 채우므로 순서를 뒤집어
      // 처치·조제실이 동선 쪽 첫 자리에 오게 한다
      const orderKeys = techSide === "left" ? [...patientKeys] : [...patientKeys].reverse();
      // 폭 부족 시 우선순위 낮은(안쪽 지원) 실부터 제외해 프런트 실을 보장
      const fitKeys = [...orderKeys];
      while (fitKeys.length &&
             fitKeys.reduce((s, key) => s + sdim(equipmentData[key].width) + 10, 0) > xMax - bandX0) {
        if (techSide === "left") fitKeys.shift(); else fitKeys.pop();
      }
      let px = bandX0;
      fitKeys.forEach((key) => {
        const spec = equipmentData[key];
        const w = sdim(spec.width);
        if (px + w > xMax) return;
        const roomTop = H - patientBandH - M;
        addEquipment(key, { left: px, top: roomTop, width: w, height: patientBandH, silent: true });
        // 문: 위쪽 변(복도 쪽)에 달고 실 내부(아래)로 열리는 여닫이문
        addDoor("swing_door", { left: px + 110, top: roomTop + 90, angle: 180, silent: true });
        // 문 개폐 구역(상단 좌측)을 피해서 기본 오브젝트 배치
        populateRoom(key, px, roomTop, w, patientBandH,
          [{ x0: px + 15, x1: px + 120, y0: roomTop - 5, y1: roomTop + 100 }]);
        px += w + 10;
      });
    }

    // ── 격리실: 기술 밴드 반대편 상단 코너 (+격리 병상) ──
    let isoZone = null;
    let isoBedGrp = null;
    const placedBeds = [];
    if (hasIso) {
      const spec = equipmentData.isolation_room;
      const ix = techSide === "left" ? W - spec.width - M : M;
      addEquipment("isolation_room", { left: ix, top: M, silent: true });
      addDoor("sliding_door", { left: ix + 60, top: M + spec.height - 4, silent: true });
      populateRoom("isolation_room", ix, M, spec.width, spec.height,
        [{ x0: ix + 50, x1: ix + 190, y0: M + spec.height - 100, y1: M + spec.height + 5 }]); // 미닫이문 회피
      if (placedBeds.length < target) {
        isoBedGrp = addBedUnit(ix + 60, M + 40, true);
        placedBeds.push({ grp: isoBedGrp, rowY: M + 40 });
      }
      isoZone = { left: ix, right: ix + spec.width, top: M, bottom: M + spec.height };
    }

    // ── N.S 아일랜드: 병상 필드 상단, 주 동선 옆 (참고 도면의 U자 카운터) ──
    // 개방면이 병상 쪽(아래)을 향해 모든 병상 열을 한눈에 관찰하고,
    // 주 동선에 접해 있어 출입구·처치실·조제실과의 동선이 짧다.
    let nsZone = null;
    if (hasNS) {
      const probe = { desks: Math.min(4, Math.ceil(stationSeats / 2)) };
      const perRow = probe.desks > 2 ? 2 : 1;
      const nsW = 70 + perRow * 172;
      let nsX = techSide === "left" ? corridor.x0 - nsW - 20 : corridor.x1 + 20;
      let nsY = M + 20;
      // 격리실과 겹치면 아래로 내린다
      if (isoZone && nsX < isoZone.right && nsX + nsW > isoZone.left) nsY = isoZone.bottom + 30;
      nsX = Math.max(fieldX0, Math.min(nsX, fieldX1 - nsW));
      const ns = addStationIsland(nsX, nsY, stationSeats);
      nsZone = { left: nsX, right: nsX + ns.w, top: nsY, bottom: nsY + ns.h };
      // 관찰 시야 표시: 개방면(아래)에서 병상 필드로 향하는 시야각
      const eye = new fabric.Text("▽ 관찰 시야", {
        left: nsX + ns.w / 2, top: nsY + ns.h + 6, fontSize: 20, fill: "#E65100",
        originX: "center", selectable: false, evented: false,
      });
      eye.meta = { key: "annotation", label: "N.S 관찰 시야" };
      canvas.add(eye);
    }

    // ── 병상 필드: 콘솔 양면(back-to-back) 밴드 구조 ──
    // 조건 ④: 하나의 배관 콘솔을 사이에 두고 위(머리↓)/아래(머리↑) 양방향으로
    // 병상 유닛을 설치한다. 밴드 피치 = 병상 + 콘솔 + 병상 + 통로.
    // 병상 모듈(침대+투석기 존)은 서로 붙여 배치: 피치 = 모듈 폭
    // (참고 도면의 1800mm 병상 피치 — 침대 사이는 장비 존으로 분리)
    const MW = moduleWidth;
    const pitch = MW;

    /** 한 행 채우기: 통로·격리실을 피해 좌→우로 병상 유닛 배치 */
    /** 지정한 세로 구간에서 격리실·N.S 아일랜드를 피한 병상 배치 가능 x 범위 */
    const boundsFor = (yTop, yBottom) => {
      let rx0 = fieldX0, rx1 = fieldX1;
      [isoZone, nsZone].forEach((z) => {
        if (!z) return;
        if (yBottom < z.top - 40 || yTop > z.bottom + 40) return; // 세로로 안 겹침
        const fieldMid = (fieldX0 + fieldX1) / 2;
        if ((z.left + z.right) / 2 > fieldMid) rx1 = Math.min(rx1, z.left - 45);
        else rx0 = Math.max(rx0, z.right + 45);
      });
      return { rx0, rx1 };
    };

    // 밴드 내 위/아래 행은 동일한 x 범위를 사용해 모듈이 세로로 정렬되게 한다
    // (행이 어긋나면 콘솔 건너편 병상과 대각선 간격이 좁아진다)
    const fillRow = (yBed, headDown, bounds) => {
      let { rx0, rx1 } = bounds ?? boundsFor(yBed, yBed + 220);
      const row = [];
      let x = rx0;
      while (x + MW <= rx1 && placedBeds.length < target) {
        if (corridor && x + MW > corridor.x0 && x < corridor.x1) {
          x = Math.round((corridor.x1 + 10) / 10) * 10; // 주 동선 통로는 비운다
          continue;
        }
        const grp = addBedUnit(x, yBed, false, headDown);
        row.push(grp);
        placedBeds.push({ grp, rowY: yBed });
        x += pitch;
      }
      return row;
    };

    /** 양쪽 행의 병상 구간을 합쳐 콘솔 스트립을 구간별로 깐다.
     *  트렁크 쪽 구간은 기술 밴드 안쪽 벽면까지 연장 — 문 앞 복도를 가로지르는
     *  배관이 콘솔(바닥 트렌치) 내부로 수용되어 동선 위를 지나지 않는다. */
    const layConsole = (cy, bedsAB) => {
      const iv = bedsAB.map((b) => [b.left - 15, b.left + b.width + 15])
        .sort((a, b) => a[0] - b[0]);
      const merged = [];
      iv.forEach(([s, e]) => {
        const cur = merged[merged.length - 1];
        if (cur && s - cur[1] <= 50) cur[1] = Math.max(cur[1], e);
        else merged.push([s, e]);
      });
      if (merged.length) {
        if (techSide === "left") merged[0][0] = techBandW + M + 2;
        else merged[merged.length - 1][1] = W - techBandW - M - 2;
      }
      merged.forEach(([s, e]) =>
        addEquipment("bed_console", { left: s, top: cy, width: e - s, silent: true }));
    };

    const bands = []; // { consoleY, above: [...], below: [...] }
    // 첫 밴드 위 행은 발쪽이 상단 벽을 향하므로 발-벽 이격 800mm을 확보하고 시작
    let by = Math.max(M + 20, MEDICAL_RULES.FOOT_WALL_CLEARANCE_CM);
    while (placedBeds.length < target && by + 220 + CD + 220 <= fieldY1) {
      // 양면 밴드: 위 행(머리 아래쪽) + 콘솔 + 아래 행(머리 위쪽)
      const bandBounds = boundsFor(by, by + 220 + CD + 6 + 220);
      const above = fillRow(by, true, bandBounds);
      const consoleY = by + 220 + 3;
      const below = fillRow(by + 220 + CD + 6, false, bandBounds);
      if (above.length || below.length) {
        layConsole(consoleY, [...above, ...below]);
        bands.push({ consoleY, above, below });
      }
      by += 220 + CD + 6 + 220 + aisle;
    }
    // 남은 높이에 단면(콘솔 위 머리↑) 행 하나를 추가 시도
    if (placedBeds.length < target && by + CD + 220 <= fieldY1) {
      const single = fillRow(by + CD + 6, false);
      if (single.length) {
        layConsole(by + 3, single);
        bands.push({ consoleY: by + 3, above: [], below: single });
      }
    }
    // 격리 병상 머리맡 콘솔
    if (isoBedGrp) {
      addEquipment("bed_console", {
        left: isoBedGrp.left - 15, top: isoBedGrp.top - CD - 3,
        width: isoBedGrp.width + 30, silent: true,
      });
    }

    // ── 동선 표시: 출입구 ↔ 스테이션 ↔ 병상 필드 주 통로 음영 + 화살표 ──
    if (corridor) {
      // 격리실과 겹치는 위치면 통로 음영을 격리실 아래부터 시작
      const zoneTop = (isoZone && corridor.x1 > isoZone.left && corridor.x0 < isoZone.right)
        ? isoZone.bottom + 20 : M + 10;
      const zone = new fabric.Rect({
        left: corridor.x0, top: zoneTop,
        width: corridor.x1 - corridor.x0, height: H - patientBandH - M - 10 - zoneTop,
        fill: "rgba(255,213,79,0.12)", stroke: "#F9A825",
        strokeWidth: 2, strokeDashArray: [18, 12],
        selectable: false, evented: false,
      });
      zone.meta = { key: "annotation", label: "주 동선" };
      canvas.add(zone);
      const cc = (corridor.x0 + corridor.x1) / 2;
      for (let ay = H - patientBandH - M - 90; ay > M + 80; ay -= 320) {
        const tri = new fabric.Triangle({
          left: cc - 18, top: ay, width: 36, height: 46,
          fill: "rgba(249,168,37,0.55)", selectable: false, evented: false,
        });
        tri.meta = { key: "annotation" };
        canvas.add(tri);
      }
      const label = new fabric.Text("주 동선", {
        left: cc, top: H - patientBandH - M - 45, fontSize: 26, fill: "#F57F17",
        originX: "center", selectable: false, evented: false,
      });
      label.meta = { key: "annotation" };
      canvas.add(label);
    }

    // ── 보조 동선: 주 동선에서 각 병상 통로로 이어지는 간호(치료) 이동로 ──
    {
      const sx0 = techSide === "left" ? techBandW + M + 20 : corridor.x1 + 5;
      const sx1 = techSide === "left" ? corridor.x0 - 5 : W - techBandW - M - 20;
      const subPath = (yc) => {
        if (sx1 - sx0 < 200) return;
        const ln = new fabric.Line([sx0, yc, sx1, yc], {
          stroke: "#2E7D32", strokeWidth: 3, strokeDashArray: [14, 10],
          opacity: 0.8, selectable: false, evented: false,
        });
        ln.meta = { key: "annotation", label: "보조 동선" };
        canvas.add(ln);
        [[sx0 + 26, 270], [sx1 - 26, 90]].forEach(([ax, ang]) => {
          const tri = new fabric.Triangle({
            left: ax, top: yc, width: 22, height: 22, angle: ang,
            originX: "center", originY: "center",
            fill: "rgba(46,125,50,0.65)", selectable: false, evented: false,
          });
          tri.meta = { key: "annotation" };
          canvas.add(tri);
        });
        const t = new fabric.Text("보조 동선", {
          left: (sx0 + sx1) / 2, top: yc - 32, fontSize: 20, fill: "#2E7D32",
          originX: "center", selectable: false, evented: false,
        });
        t.meta = { key: "annotation" };
        canvas.add(t);
      };
      // 밴드 사이 통로마다 + 환자 밴드 앞 가로 복도에 표시
      bands.forEach((b) => {
        const bandBottom = b.consoleY + CD + 3 + 220;
        if (bandBottom + 60 < fieldY1) subPath(Math.min(bandBottom + aisle / 2, fieldY1 - 40));
      });
      subPath(fieldY1 + DOOR_CLEAR / 2); // 환자 밴드 문 앞 복도 (탈의실→병상 동선)
    }

    // ── 배관: 신장실 계통 트렁크(기술 밴드 벽체 매입) → 콘솔 내부 주행 → 분기 ──
    // 동선-배관 분리: 트렁크는 문 앞 복도가 아닌 기술 밴드 안쪽 벽체 체이스로
    // 주행하고, 수평 주행은 항상 콘솔(트렌치) 내부를 지난다.
    // 계통 분리: 정수실 내부 배관과 신장실 배관은 서로 연결하지 않는다 —
    // 트렁크는 정수실 '벽면 인계점(RO 공급/배수 접속)'에서 시작한다.
    const wt = getObjects().find((o) => o.meta.key === "water_treatment");
    if (wt && bands.length) {
      const inletYOf = (cy) => Math.round(cy + CD * 0.35); // 콘솔 안 급수 주행 높이
      const drainYOf = (cy) => Math.round(cy + CD * 0.7);  // 콘솔 안 배수 주행 높이
      const trunkX = techSide === "left" ? M + techBandW - 15 : W - M - techBandW + 15; // 벽체 매입 체이스
      const handoverY = wt.top + 15; // 정수실 상단 벽면 인계점
      const trunk = [
        { x: trunkX, y: handoverY },
        { x: trunkX, y: inletYOf(bands[0].consoleY) },
      ];
      const off = techSide === "left" ? -14 : 14; // 배수 트렁크 평행 오프셋
      addPipe(trunk, "inlet");
      addPipe(trunk.map((p) => ({ x: p.x + off, y: p.y + 14 })), "drain");
      // 인계점 마커: 정수실 계통 ↔ 신장실 계통 분리 지점
      const tap = new fabric.Circle({
        left: trunkX - 10, top: handoverY - 10, radius: 10,
        fill: "#ffffff", stroke: "#1565C0", strokeWidth: 3,
        selectable: false, evented: false,
      });
      tap.meta = { key: "annotation", label: "RO 인계점" };
      canvas.add(tap);
      const tapLabel = new fabric.Text("RO 인계점 (계통 분리)", {
        left: techSide === "left" ? trunkX - 25 : trunkX + 25,
        top: handoverY + 18, fontSize: 18, fill: "#1565C0",
        originX: techSide === "left" ? "right" : "left",
        selectable: false, evented: false,
      });
      tapLabel.meta = { key: "annotation" };
      canvas.add(tapLabel);
      bands.forEach(({ consoleY, above, below }) => {
        const all = [...above, ...below];
        const farX = techSide === "left"
          ? Math.max(...all.map((b) => b.left + b.width))
          : Math.min(...all.map((b) => b.left));
        addPipe([{ x: trunkX, y: inletYOf(consoleY) }, { x: farX, y: inletYOf(consoleY) }], "inlet");
        addPipe([{ x: trunkX, y: drainYOf(consoleY) }, { x: farX, y: drainYOf(consoleY) }], "drain");
        // 위 행(머리 아래쪽): 콘솔에서 위로 분기 / 아래 행(머리 위쪽): 아래로 분기
        // 분기 위치는 모듈 내 장비 존 중앙(투석기 위치)
        const pxOf = (b) => b.left + Math.round((b.width + 120) / 2);
        above.forEach((b) => {
          addPipe([{ x: pxOf(b), y: inletYOf(consoleY) }, { x: pxOf(b), y: b.top + 200 }], "inlet");
        });
        below.forEach((b) => {
          addPipe([{ x: pxOf(b), y: inletYOf(consoleY) }, { x: pxOf(b), y: b.top + 20 }], "inlet");
        });
      });
      // 격리 병상 분기: 첫 밴드 주행선 끝에서 격리실 안까지 연장
      if (isoBedGrp) {
        const runY0 = inletYOf(bands[0].consoleY);
        const isoPx = isoBedGrp.left + Math.round((isoBedGrp.width + 120) / 2);
        const first = [...bands[0].above, ...bands[0].below];
        const farX = techSide === "left"
          ? Math.max(...first.map((b) => b.left + b.width))
          : Math.min(...first.map((b) => b.left));
        addPipe([{ x: farX, y: runY0 }, { x: isoPx, y: runY0 },
                 { x: isoPx, y: isoBedGrp.top + 20 }], "inlet");
      }
    }

    renumberBeds(); // HD1부터 행→열 순으로 부여
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    endBulk();
    return {
      placed: placedBeds.length,
      target,
      variant: {
        techSide, aisle, moduleWidth: MW, consoleDepth: CD,
        // 부속시설(실) 면적 : 전체 면적 비율 — 조건 ③ 1:1 목표
        facilityRatio: Math.round((baseArea * kScale * kScale) / (W * H) * 100) / 100,
      },
    };
  }

  /* ───────────────── 편집 도구 (EdrawMax 스타일) ─────────────────
   * 실행취소/다시실행 · 복사/붙여넣기/복제 · 정렬/등간격 · 순서 · 반전 · 잠금 · 줌 */

  function beginBulk() { histDepth += 1; }
  function endBulk() {
    histDepth = Math.max(0, histDepth - 1);
    if (!histDepth) saveHistory();
  }

  /** 현재 도면을 히스토리에 저장 (연속 이벤트는 250ms 디바운스로 1회 기록) */
  function saveHistory() {
    if (histDepth > 0 || restoring || !canvas) return;
    clearTimeout(histTimer);
    histTimer = setTimeout(() => {
      if (histDepth > 0 || restoring) return;
      history = history.slice(0, histIndex + 1);
      history.push(JSON.stringify(toJSON()));
      if (history.length > 50) history.shift();
      histIndex = history.length - 1;
    }, 250);
  }

  function restoreSnapshot(idx) {
    restoring = true;
    const data = JSON.parse(history[idx]);
    room = data.room;
    canvas.loadFromJSON(data.canvas, () => {
      restoring = false;
      canvas.requestRenderAll();
    });
  }

  function undo() {
    if (histIndex <= 0) return false;
    histIndex -= 1;
    restoreSnapshot(histIndex);
    return true;
  }

  function redo() {
    if (histIndex >= history.length - 1) return false;
    histIndex += 1;
    restoreSnapshot(histIndex);
    return true;
  }

  /* ── 복사 / 붙여넣기 / 복제 ──
   * clone은 scaleX/scaleY·angle·flip을 그대로 가져가므로
   * 속성 패널에서 크기를 조정한 객체도 조정된 크기 그대로 복제된다. */
  function copySelection() {
    const o = canvas.getActiveObject();
    if (!o) return false;
    o.clone((c) => { clipboard = c; }, ["meta"]);
    return true;
  }

  function pasteClipboard() {
    if (!clipboard) return false;
    clipboard.clone((c) => {
      beginBulk();
      canvas.discardActiveObject();
      c.set({ left: c.left + 20, top: c.top + 20, evented: true });
      if (c.type === "activeSelection") {
        // 다중 선택 복사: 구성 객체를 개별로 추가
        c.canvas = canvas;
        c.forEachObject((obj) => canvas.add(obj));
        c.setCoords();
      } else {
        canvas.add(c);
      }
      applyBlueprintToObject(c);
      canvas.setActiveObject(c);
      canvas.requestRenderAll();
      endBulk();
    }, ["meta"]);
    return true;
  }

  function duplicateSelection() {
    return copySelection() && pasteClipboard();
  }

  /* ── 정렬 / 등간격 배치 ── */
  /** 다중 선택을 절대 좌표로 계산한 뒤 다시 선택 상태로 되돌리는 공통 래퍼 */
  function withSelection(minCount, fn) {
    const sel = canvas.getActiveObject();
    if (!sel || sel.type !== "activeSelection" || sel.getObjects().length < minCount) return false;
    const objs = sel.getObjects();
    canvas.discardActiveObject(); // 선택 좌표계 → 절대 좌표계
    fn(objs.map((o) => ({ o, r: o.getBoundingRect(true) })));
    objs.forEach((o) => o.setCoords());
    canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
    canvas.requestRenderAll();
    saveHistory();
    return true;
  }

  /** axis: "h"(가로 등간격) | "v"(세로 등간격) — 3개 이상 선택 시 */
  function distributeSelection(axis) {
    return withSelection(3, (items) => {
      const pos = axis === "h" ? "left" : "top";
      const size = axis === "h" ? "width" : "height";
      items.sort((a, b) => a.r[pos] - b.r[pos]);
      const start = items[0].r[pos];
      const end = Math.max(...items.map((i) => i.r[pos] + i.r[size]));
      const total = items.reduce((s, i) => s + i.r[size], 0);
      const gap = (end - start - total) / (items.length - 1);
      let cursor = start;
      items.forEach(({ o, r }) => {
        const delta = cursor - r[pos];
        if (axis === "h") o.set("left", o.left + delta);
        else o.set("top", o.top + delta);
        cursor += r[size] + gap;
      });
    });
  }

  /* ── 순서 (Z-order) ── */
  function bringSelectionToFront() {
    const o = canvas.getActiveObject();
    if (!o) return false;
    o.bringToFront();
    canvas.requestRenderAll();
    return true;
  }

  function sendSelectionToBack() {
    const o = canvas.getActiveObject();
    if (!o) return false;
    o.sendToBack();
    // 주석 → 외벽 → 그리드 순으로 다시 최하단으로 보내 배경 구조를 유지
    ["annotation", "wall", "grid"].forEach((key) => {
      canvas.getObjects().filter((g) => g.meta && g.meta.key === key)
        .forEach((g) => g.sendToBack());
    });
    canvas.requestRenderAll();
    return true;
  }

  /* ── 반전 / 잠금 ── */
  function flipSelection(axis) {
    const o = canvas.getActiveObject();
    if (!o) return false;
    if (axis === "h") o.set("flipX", !o.flipX);
    else o.set("flipY", !o.flipY);
    canvas.requestRenderAll();
    saveHistory();
    return true;
  }

  /** 잠금 토글: 이동/회전/크기 조절을 막는다. 반환값 = 잠금 여부(null = 선택 없음) */
  function toggleLockSelection() {
    const o = canvas.getActiveObject();
    if (!o || !o.meta) return null;
    const lock = !o.meta.locked;
    o.meta.locked = lock;
    o.set({
      lockMovementX: lock, lockMovementY: lock, lockRotation: lock,
      lockScalingX: lock, lockScalingY: lock,
      hasControls: !lock, opacity: lock ? 0.85 : 1,
    });
    canvas.requestRenderAll();
    return lock;
  }

  /* ── 줌 컨트롤 ── */
  function zoomBy(factor) {
    const z = Math.min(4, Math.max(0.05, canvas.getZoom() * factor));
    canvas.zoomToPoint({ x: canvas.getWidth() / 2, y: canvas.getHeight() / 2 }, z);
    canvas.requestRenderAll();
    return z;
  }

  /* ── PNG / SVG 내보내기 ── */
  function exportSVG() {
    const saved = canvas.viewportTransform.slice();
    canvas.discardActiveObject();
    canvas.renderAll();
    const pad = 40;
    const svg = canvas.toSVG({
      viewBox: {
        x: -WALL - pad, y: -WALL - pad,
        width: room.width + WALL * 2 + pad * 2,
        height: room.height + WALL * 2 + pad * 2 + 40, // 하단 주석 여유
      },
      width: room.width + WALL * 2 + pad * 2,
      height: room.height + WALL * 2 + pad * 2 + 40,
    });
    canvas.setViewportTransform(saved);
    canvas.requestRenderAll();
    return svg;
  }

  /* ───────────────── 조회/직렬화 유틸 ───────────────── */
  /** 그리드·벽·주석을 제외한 배치 객체 목록 */
  function getObjects() {
    return canvas.getObjects().filter((o) => o.meta && !["grid", "wall", "annotation"].includes(o.meta.key));
  }

  function deleteSelection() {
    const sel = canvas.getActiveObjects();
    sel.forEach((o) => canvas.remove(o));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }

  function toJSON() {
    return {
      version: 1,
      room,
      canvas: canvas.toJSON(["meta", "selectable", "evented"]),
    };
  }

  function loadJSON(data, done) {
    beginBulk();
    room = data.room;
    canvas.loadFromJSON(data.canvas, () => {
      endBulk();
      // 불러온 도면의 HD 번호 최댓값에서 병상 카운터를 이어간다
      bedCounter = canvas.getObjects().reduce((max, o) => {
        const m = o.meta && typeof o.meta.name === "string" && o.meta.name.match(/^HD(\d+)$/);
        return m ? Math.max(max, +m[1]) : max;
      }, 0);
      fitToScreen();
      canvas.requestRenderAll();
      if (done) done();
    });
  }

  /** PDF/PNG 출력용: 도면 전체 영역을 고해상도 이미지로 렌더링 */
  function exportImage(format = "jpeg") {
    const saved = canvas.viewportTransform.slice();
    fitToScreen();
    canvas.discardActiveObject();
    canvas.renderAll();
    // PDF용 JPEG: PNG 대비 용량을 크게 줄임 (배경이 흰색이라 품질 손실 없음)
    const url = format === "png"
      ? canvas.toDataURL({ format: "png", multiplier: 2 })
      : canvas.toDataURL({ format: "jpeg", quality: 0.9, multiplier: 2 });
    canvas.setViewportTransform(saved);
    canvas.requestRenderAll();
    return url;
  }

  return {
    init, newRoom, setBackgroundImage, addEquipment, addPipe, addDoor,
    groupSelection, ungroupSelection, togglePipeMode, finishPipe,
    autoLayout, autoModel, getObjects, deleteSelection, toJSON, loadJSON, exportImage,
    fitToScreen,
    setWallThickness, setConsoleDepth, setModuleWidth, setStationSeats, addBedUnit,
    renumberBeds, renameSelected, setBlueprintMode,
    undo, redo, copySelection, pasteClipboard, duplicateSelection,
    distributeSelection, bringSelectionToFront, sendSelectionToBack,
    flipSelection, toggleLockSelection, zoomBy, exportSVG,
    setSnap: (s) => { snapSize = s; },
    getRoom: () => room,
    getCanvas: () => canvas,
  };
})();
