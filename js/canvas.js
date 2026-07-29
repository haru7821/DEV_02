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
  let variantSeq = 0;         // 자동 배치 골격 순환 카운터 (연속 실행 시 16가지 순회)

  // ── 실행 취소/다시 실행 히스토리 ──
  let history = [];           // JSON 스냅샷 스택
  let histIndex = -1;         // 현재 스냅샷 위치
  let histDepth = 0;          // >0 이면 일괄 작업 중 (기록 안 함)
  let restoring = false;      // undo/redo 복원 중
  let histTimer = null;
  let clipboard = null;       // 복사/붙여넣기 버퍼

  const GRID_STEP = 50;       // 화면에 그리는 그리드 간격(cm)
  // 기본 치수는 업로드 실측 도면(reference-plans/) 기준값을 사용한다 — MEDICAL_RULES 참조
  let WALL = 10;              // 벽 두께(cm) — setWallThickness()로 변경
  let consoleDepth = MEDICAL_RULES.CONSOLE_DEPTH_CM; // 배관 콘솔 두께(cm) — 27bed 실측 640mm
  let moduleWidth = MEDICAL_RULES.MODULE_PITCH_CM;   // 병상 모듈 폭(cm) — 27bed 실측 1,800mm
  let moduleDepth = MEDICAL_RULES.MODULE_DEPTH_CM;   // 병상 모듈 세로 길이(cm): 침대 길이 기준
  let stationSeats = 4;       // 간호 스테이션 좌석 수 (2인 데스크 단위, 최대 8석)

  /** 벽 두께 설정(cm). 다음 새 도면/자동 배치부터 적용된다. */
  function setWallThickness(t) {
    WALL = Math.min(40, Math.max(5, Math.round(+t) || 10));
  }

  /** 배관 콘솔 두께 설정(cm). 이후 추가/자동 배치되는 콘솔부터 적용된다. */
  function setConsoleDepth(t) {
    consoleDepth = Math.min(80, Math.max(10, Math.round(+t) || MEDICAL_RULES.CONSOLE_DEPTH_CM));
  }

  /** 병상 모듈 폭 설정(cm). 침대(120cm)+투석기 존으로 구성되며 최소 175cm. */
  function setModuleWidth(t) {
    moduleWidth = Math.min(300, Math.max(150, Math.round(+t) || MEDICAL_RULES.MODULE_PITCH_CM));
  }

  /** 병상 모듈 세로 길이 설정(cm). 침대 길이 기준, 180~320cm. */
  function setModuleDepth(t) {
    moduleDepth = Math.min(320, Math.max(170, Math.round(+t) || MEDICAL_RULES.MODULE_DEPTH_CM));
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

  /** 병실 치수만 변경 (캔버스는 지우지 않음) — Auto Modeling이 잠긴 객체를
   *  보존한 채 스스로 재구성할 때 사용한다. */
  function setRoomSize(w, h) {
    room = { width: w, height: h };
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
    // 구조 기둥 기호: 진한 채움 + 흰 대각선 X (건축 도면의 기둥 표기)
    if (spec.symbol === "pillar") {
      rect.set({ fill: spec.color + "E6" });
      parts.push(new fabric.Line(
        [-spec.width / 2, -spec.height / 2, spec.width / 2, spec.height / 2],
        { stroke: "#ffffff", strokeWidth: 2 }));
      parts.push(new fabric.Line(
        [-spec.width / 2, spec.height / 2, spec.width / 2, -spec.height / 2],
        { stroke: "#ffffff", strokeWidth: 2 }));
    }
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
      // 착석 방향: 의자가 위(뒤쪽 벽/카운터 쪽), 책상 상판이 아래.
      // N.S 아일랜드에서 간호사가 개방면(아래=병상)을 바라보고 앉는다.
      parts.push(new fabric.Rect({
        width: spec.width - 12, height: spec.height * 0.42,
        fill: spec.color, opacity: 0.75,
        originX: "center", originY: "center", top: spec.height * 0.24,
      }));
      [-1, 1].forEach((s) => {
        parts.push(new fabric.Rect({
          width: 36, height: 32, rx: 7, ry: 7,
          fill: "#ffffff", stroke: spec.color, strokeWidth: 2,
          originX: "center", originY: "center",
          left: s * spec.width * 0.22, top: -spec.height * 0.26,
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
    applyLayerTo(grp); // 배관 레이어를 숨겨 둔 상태면 새 배관도 숨김을 따른다
    return grp;
  }

  /* ───────────────── 문(개구부) 추가 ─────────────────
   * 건축 도면 기호로 렌더링. 가로 방향(문 폭 = x축)으로 그리고
   * 사용자가 회전(angle)으로 벽에 맞춘다. */
  function addDoor(key, opts = {}) {
    const spec0 = doorData[key];
    if (!spec0) return null;
    // opts.width로 문 폭 재정의 가능 (예: 정수실 장비 반입용 1000mm)
    const spec = opts.width ? { ...spec0, width: Math.round(opts.width) } : spec0;
    const DW = spec.width;

    // 공통: 개구부(벽 절개) 표현 — 흰색 바탕 사각형
    const parts = [
      new fabric.Rect({
        left: 0, top: -7, width: DW, height: 14,
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
      // 경첩은 개구부 한쪽 끝(0,0). 문짝을 '열린 상태'로, 즉 옆 벽면에
      // 나란히 접힌 모습으로 그린다 — 문이 통로를 막지 않는 배치를 나타낸다.
      // 개폐 궤적(1/4 원호)은 닫힌 위치까지의 회전을 점선으로 표시.
      parts.push(leaf([0, 0, 0, -DW]));                       // 벽면에 접힌 문짝
      parts.push(arc(`M 0 ${-DW} A ${DW} ${DW} 0 0 1 ${DW} 0`)); // 개폐 궤적
    } else if (key === "double_swing_door") {
      // 양짝 — 각 문짝이 자기 쪽 벽면에 접힌다
      const hw = DW / 2;
      parts.push(leaf([0, 0, 0, -hw]));
      parts.push(arc(`M 0 ${-hw} A ${hw} ${hw} 0 0 1 ${hw} 0`));
      parts.push(leaf([DW, 0, DW, -hw]));
      parts.push(arc(`M ${DW} ${-hw} A ${hw} ${hw} 0 0 0 ${hw} 0`));
    } else if (key === "auto_door") {
      // 슬라이딩 패널 2장(양쪽 벽 속으로 열림) + AUTO 표기
      const pw = DW / 2 - 4;
      parts.push(new fabric.Rect({
        left: 2, top: -4, width: pw, height: 8,
        fill: "#B3E5FC", stroke: spec.color, strokeWidth: 2,
      }));
      parts.push(new fabric.Rect({
        left: DW / 2 + 2, top: -4, width: pw, height: 8,
        fill: "#B3E5FC", stroke: spec.color, strokeWidth: 2,
      }));
      parts.push(new fabric.Text("AUTO", {
        fontSize: 16, fill: spec.color,
        originX: "center", left: DW / 2, top: -26,
      }));
    } else if (key === "sliding_door") {
      // 미닫이: 문짝이 옆 벽면을 따라 밀려 열린다 (개구부 + 후퇴 패널)
      parts.push(new fabric.Rect({
        left: 0, top: -10, width: DW * 0.6, height: 8,
        fill: "#CFD8DC", stroke: spec.color, strokeWidth: 2,
      }));
      parts.push(new fabric.Rect({
        left: DW * 0.45, top: 2, width: DW * 0.55, height: 8,
        fill: "#ECEFF1", stroke: spec.color, strokeWidth: 2,
      }));
    }

    // roomSide: 문이 달릴 '실의 어느 벽'인가 → 문짝이 실 안쪽으로 열리는 각도
    //   top(실이 문 아래) 180° · bottom(실이 위) 0° · left(실이 오른쪽) 90° · right(실이 왼쪽) 270°
    const SIDE_ANGLE = { top: 180, bottom: 0, left: 90, right: 270 };
    const angle = opts.roomSide ? SIDE_ANGLE[opts.roomSide] : (opts.angle ?? 0);

    const grp = new fabric.Group(parts, {
      left: opts.left ?? room.width / 2 - DW / 2,
      top: opts.top ?? room.height - 7,
      angle,
    });
    // anchor: 벽면에서 문 '개구부 중심'이 놓일 지점.
    // 회전 규약에 좌우되지 않도록, 그룹 변환행렬로 개구부의 실제 캔버스 좌표를
    // 측정한 뒤 그 오차만큼 그룹을 이동시킨다 — 각도와 무관하게 정확하다.
    if (opts.anchor) {
      grp.setCoords();
      const abs = fabric.util.transformPoint(
        parts[0].getCenterPoint(), grp.calcTransformMatrix());
      grp.set({
        left: grp.left + (opts.anchor.x - abs.x),
        top: grp.top + (opts.anchor.y - abs.y),
      });
      grp.setCoords();
    }
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
    // 앵커(벽면 지점) + roomSide로 지정 — 문이 항상 벽에 붙고 실 안쪽으로 열린다
    addDoor("auto_door", { anchor: { x: nurseX - 130, y: H }, roomSide: "bottom", silent: true }); // 주 출입구
    addDoor("swing_door", { anchor: { x: M + 100, y: H - 260 }, roomSide: "top", silent: true });  // 탈의실
    addDoor("swing_door", { anchor: { x: 295, y: H - 210 }, roomSide: "top", silent: true });      // 화장실
    addDoor("swing_door", { anchor: { x: 310, y: 210 }, roomSide: "left", silent: true });         // 정수실 (바깥여닫이)
    addDoor("swing_door", { anchor: { x: 210, y: 520 }, roomSide: "right", silent: true });        // 창고
    if (hasIsolation) {
      addDoor("sliding_door", { anchor: { x: W - isoW / 2 - M, y: 310 }, roomSide: "bottom", silent: true }); // 격리실
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
    const mw = moduleWidth, md = moduleDepth;
    // 모듈 경계: 침대 + 장비 존을 하나의 타일로 묶는 점선 프레임
    const frame = new fabric.Rect({
      left: x, top: y, width: mw, height: md,
      fill: "rgba(96,125,139,0.05)",
      stroke: "#90A4AE", strokeWidth: 1.5, strokeDashArray: [8, 6],
    });
    frame.meta = { key: "module_frame", label: "모듈 경계" };
    canvas.add(frame);
    // 투석기는 '항상 침대(환자) 기준 오른쪽'에 둔다.
    // 머리 방향이 아래(headDown)인 행은 환자가 반대로 누우므로 환자의 오른쪽이
    // 화면상 왼쪽이 된다 → 모듈 중심을 기준으로 침대·투석기를 좌우 반전한다.
    const MACHINE_W = 50, BED_W = 120;
    const gapIn = Math.max(3, Math.round((mw - BED_W - MACHINE_W) / 2)); // 장비 존 중앙
    let bedX = x, macX = x + BED_W + gapIn;                              // 기본: [침대][투석기]
    if (headDown) {                                                      // 반전: [투석기][침대]
      macX = x + mw - (macX - x) - MACHINE_W;
      bedX = x + mw - BED_W;
    }
    // 침대는 유닛 내부이므로 inUnit으로 단독 HD 번호 부여를 건너뛰고, 유닛에 번호를 준다
    const bed = addEquipment("dialysis_bed", { left: bedX, top: y, height: md, silent: true, inUnit: true });
    // 세로 위치는 머리맡(콘솔 쪽) — 배관이 콘솔에서 바로 내려온다
    const machine = addEquipment("dialysis_machine", { left: macX, top: headDown ? y + md - 70 : y, silent: true });
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

  /**
   * 세로 콘솔용 병상 모듈 — 가로 모듈을 전치한 형태 (27bed 도면의 팟 구조).
   * 머리맡이 좌/우를 향하고 콘솔이 세로로 지나간다. headLeft=true면 머리맡이 왼쪽.
   * 침대는 모듈 폭을 가득 채우고, 투석기는 머리 방향과 무관하게
   * '항상 침대의 오른쪽(모듈 오른쪽 끝)'에 둔다 — 세로 모드에서도 도면을 볼 때
   * [침대][투석기] 순서가 일정하게 읽히도록 한다.
   * 세로 위치는 침대와 겹치지 않는 모듈 내 여유 구간(병상 사이 틈)이다.
   */
  function addBedUnitV(x, y, isolated, headLeft) {
    const mw = moduleWidth, md = moduleDepth; // mw = 병상 피치(세로), md = 침대 길이(가로)
    const frame = new fabric.Rect({
      left: x, top: y, width: md, height: mw,
      fill: "rgba(96,125,139,0.05)",
      stroke: "#90A4AE", strokeWidth: 1.5, strokeDashArray: [8, 6],
    });
    frame.meta = { key: "module_frame", label: "모듈 경계" };
    canvas.add(frame);
    const BED_W = 120, MACHINE_W = 50;   // 침대 폭 · 투석기 폭 (전치 시 세로 치수)
    const MAC_L = 70;                    // 투석기 가로 치수 (전치 시)
    const gapIn = Math.max(3, Math.round((mw - BED_W - MACHINE_W) / 2));
    const bedY = headLeft ? y : y + mw - BED_W;
    const macY = headLeft ? y + mw - gapIn - MACHINE_W : y + gapIn;
    const bed = addEquipment("dialysis_bed", {
      left: x, top: bedY, width: md, height: BED_W, silent: true, inUnit: true,
    });
    // 투석기는 머리 방향과 무관하게 항상 모듈 오른쪽 끝 — [침대][투석기]
    const machine = addEquipment("dialysis_machine", {
      left: x + md - MAC_L, top: macY,
      width: MAC_L, height: MACHINE_W, silent: true,
    });
    const sel = new fabric.ActiveSelection([frame, bed, machine], { canvas });
    const grp = sel.toGroup();
    grp.meta = {
      key: "bed_unit",
      label: isolated ? "격리 병상 유닛" : "병상 유닛",
      requiresWater: true, isolationCapable: true, isolated,
      headDown: false,
      vertical: true, headLeft,   // 발쪽이 좌/우 → 발-벽 이격은 가로 방향으로 검사
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
      case "consult_room": // 작업대 + 수납
        put("counter_desk", 12, 12, { width: Math.min(w - 30, 180) });
        put("cabinet", 12, h - 57);
        break;
      case "laundry_room":
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

  /* ───────────────── 치수선 (통로 폭 등) ─────────────────
   * axis "h": (a,b)는 x좌표, pos는 y좌표 / "v": (a,b)는 y좌표, pos는 x좌표
   * 건축 도면처럼 양끝 짧은 보조선 + 화살표 + mm 치수 텍스트를 그린다. */
  function dimLine(axis, a, b, pos, color = "#455A64") {
    const len = Math.abs(b - a);
    if (len < 40) return;
    const add = (o) => { o.meta = { key: "annotation", label: "치수" }; canvas.add(o); };
    const horiz = axis === "h";
    add(new fabric.Line(horiz ? [a, pos, b, pos] : [pos, a, pos, b], {
      stroke: color, strokeWidth: 1.5, selectable: false, evented: false,
    }));
    // 양끝 보조선(연장선)
    [a, b].forEach((p) => add(new fabric.Line(
      horiz ? [p, pos - 12, p, pos + 12] : [pos - 12, p, pos + 12, p],
      { stroke: color, strokeWidth: 1.5, selectable: false, evented: false })));
    // 양끝 화살표
    [[a, horiz ? 90 : 180], [b, horiz ? 270 : 0]].forEach(([p, ang]) => add(new fabric.Triangle({
      left: horiz ? p : pos, top: horiz ? pos : p, width: 14, height: 16, angle: ang,
      originX: "center", originY: "center", fill: color, selectable: false, evented: false,
    })));
    add(new fabric.Text(String(Math.round(len * 10)), {
      left: horiz ? (a + b) / 2 : pos + 8, top: horiz ? pos - 26 : (a + b) / 2,
      fontSize: 20, fill: color,
      originX: horiz ? "center" : "left", originY: horiz ? "top" : "center",
      selectable: false, evented: false,
    }));
  }

  /* ───────────────── N.S 아일랜드 (U자형 개방 카운터) ─────────────────
   * 참고 도면의 간호 스테이션: 병상 필드 안에 독립 배치된 U자 카운터로,
   * 개방면이 병상 쪽을 향해 모든 병상 열을 관찰한다. 내부에 2인 데스크
   * 유닛(stationSeats/2 조)을 배치한다. */
  function addStationIsland(x, y, seats, entrySide = "left") {
    // 데스크는 1열로 나란히 놓여 모두 병상(개방면=아래)을 바라본다.
    // 25BED 도면의 N.S 카운터 실측 5,878mm에 2인 데스크 5조 → 1조당 피치 1,180mm.
    const desks = Math.min(4, Math.ceil((seats ?? stationSeats) / 2));
    const pitch = MEDICAL_RULES.NS_DESK_PITCH_CM;
    const bar = 40;                                  // 후면 카운터(수납) 깊이
    const entry = MEDICAL_RULES.NS_ENTRY_CM;         // 간호사 출입·통행 폭 (800mm)
    const deskH = equipmentData.station_desk2.height; // 데스크 유닛 깊이
    const innerW = desks * pitch;                    // 데스크 1열이 차지하는 폭
    const w = bar * 2 + innerW + 10;
    // 깊이 = 후면 카운터 + 간호사 통행(800mm) + 데스크. 통행 폭이 항상 확보된다.
    const h = Math.max(MEDICAL_RULES.NS_DEPTH_CM, bar + entry + deskH);
    const col = "#FF9800";
    const mk = (left, top, bw, bh) => new fabric.Rect({
      left, top, width: bw, height: bh, rx: 12, ry: 12,
      fill: col + "55", stroke: col, strokeWidth: 3,
    });
    // 출입 개구부: 한쪽 팔의 통행 구간(후면 카운터 바로 아래 800mm)을 비운다
    const openTop = bar, openBot = bar + entry;
    const arm = (left, opened) => (opened
      ? [mk(left, 0, bar, openTop), mk(left, openBot, bar, h - openBot)]
      : [mk(left, 0, bar, h)]);
    const parts = [
      mk(0, 0, w, bar),                                   // 상부 바 (닫힌 면)
      ...arm(0, entrySide === "left"),                    // 좌측 팔
      ...arm(w - bar, entrySide === "right"),             // 우측 팔
      new fabric.Text("N.S", {
        fontSize: 30, fontWeight: "bold", fill: "#E65100",
        left: w / 2, top: 4, originX: "center",
      }),
      // 출입구 표기 (개구부 중앙)
      new fabric.Text(`출입 ${entry * 10}`, {
        fontSize: 16, fill: "#E65100",
        left: entrySide === "left" ? bar / 2 : w - bar / 2,
        top: openTop + entry / 2, originX: "center", originY: "center",
        angle: 90,
      }),
    ];
    const grp = new fabric.Group(parts, { left: x, top: y });
    grp.meta = { key: "nurse_station", label: "간호 스테이션 (N.S)", type: "room" };
    canvas.add(grp);
    applyBlueprintToObject(grp);
    // 2인 데스크 유닛을 1열로 — 전원이 개방면(아래=병상)을 향해 착석하고,
    // 데스크 뒤로 800mm 통행 공간이 남아 출입 개구부와 이어진다.
    for (let i = 0; i < desks; i++) {
      addEquipment("station_desk2", {
        left: x + bar + 5 + i * pitch, top: y + h - deskH, silent: true,
      });
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
    // ── 잠금(락) 보존: 잠긴 객체는 그대로 두고 나머지 영역만 재배치한다 ──
    const lockedObjs = getObjects().filter((o) => o.meta && o.meta.locked);
    lockedObjs.forEach((o) => canvas.remove(o));
    newRoomKeepBackground(W, H);
    lockedObjs.forEach((o) => { canvas.add(o); o.setCoords(); });
    const lockedZones = lockedObjs.map((o) => {
      const r = o.getBoundingRect(true);
      // 잠긴 병상은 새 병상과 1m 이격이 지켜지도록 회피 여유를 크게 잡는다
      const m = o.meta.key === "bed_unit" ? MEDICAL_RULES.MIN_BED_GAP_CM : 15;
      return { x0: r.left - m, y0: r.top - m, x1: r.left + r.width + m, y1: r.top + r.height + m };
    });
    const lockedHas = (k) => lockedObjs.some((o) => o.meta.key === k);
    /** 사각형이 잠금 구역과 겹치는가 (겹치면 해당 구역 반환) */
    const hitLocked = (x, y, w, h) => lockedZones.find((z) =>
      x < z.x1 && x + w > z.x0 && y < z.y1 && y + h > z.y0) || null;
    const M = 10;

    // ── 통로 폭 (사용자 지정, 별도 선택) ──
    // 보조통로: 마주보는 병상 밴드 사이 간호 동선
    // (기본 1,300mm = 27bed 1,160·1,360 / 25BED 1,280·1,400의 중앙값, 최소 800mm)
    const aisle = Math.min(400, Math.max(80, Math.round(opts.passage ?? MEDICAL_RULES.SUB_AISLE_CM)));
    // 주통로: 출입구에서 필드 끝까지 이어지는 주 동선 (기본 3,370mm = 25BED 중앙 로비 실측)
    const mainCw = Math.min(600, Math.max(MEDICAL_RULES.MIN_AISLE_CM,
      Math.round(opts.mainCorridor ?? MEDICAL_RULES.MAIN_CORRIDOR_CM)));

    // ── 실 크기: 사용자 지정(roomSizes) 우선, 없으면 기본 스펙 ──
    // shrink: 병상 '대수 우선' 배치 — 목표 대수가 안 들어가면 실 크기를
    // 10%씩 단계 축소(최소 60%)해 병상 공간을 먼저 확보한다
    const shrink = opts._shrink ?? 1;
    const userSize = (k) => (opts.roomSizes && opts.roomSizes[k]) || null;
    const q10 = (v) => Math.max(100, Math.round(v / 10) * 10);

    // ── 병상 대수 연동 실 크기 ──
    // 소모품·린넨·오물량과 환자 회전율은 병상 수에 비례하므로, 관련 실은
    // 목표 대수에 따라 커지고 작아진다. 계수는 '병상 수 민감도'(0~1):
    // 1.0 = 병상 수에 그대로 비례, 0 = 대수와 무관한 고정 규격(화장실·코어 등).
    const BED_SENSITIVITY = {
      storage: 1, linen_room: 1, laundry_room: 1, waste_room: 1,
      waiting_area: 1, changing_room: 0.7, treatment_room: 0.7, pharmacy_room: 0.5,
      nurse_room: 0.6, water_treatment: 0.8,
      toilet: 0.3, consult_room: 0.2, core: 0, isolation_room: 0,
    };
    // 기준 20병상 대비 √비례 (면적이 대수에 비례하도록 한 변은 제곱근)
    const bedFactor = Math.min(1.8, Math.max(0.65, Math.sqrt(target / 20)));
    const bedScale = (k) => 1 + (bedFactor - 1) * (BED_SENSITIVITY[k] ?? 0.5);
    /** 최종 기본 치수 = 지정값(있으면) 또는 스펙 × 대수 연동, 그리고 단계 축소.
     *  패널에서 직접 입력한 실은 '제공된 크기 그대로' 쓰고 대수 연동을 적용하지 않는다. */
    const bDim = (k, dim) => {
      const u = userSize(k);
      if (u) return q10(u[dim] * shrink);
      return q10(equipmentData[k][dim === "w" ? "width" : "height"] * bedScale(k) * shrink);
    };
    const bW = (k) => bDim(k, "w");
    const bH = (k) => bDim(k, "h");

    // ── 시설 분류: 실별 특성에 따라 내부(환자 접근)/외부(후방 지원) 배치 ──
    // 외부(back-of-house) 실: 소음·오염·설비 계열 → 측면 기술 밴드(외벽 쪽)
    // 내부(patient-facing) 실: 환자가 드나드는 실 → 하단 환자 밴드(출입구 쪽)
    // 참고 도면처럼 직원 지원실(간호사실·상담실)도 후방 블록에 둔다 —
    // 환자 프런트 밴드는 환자가 쓰는 실만 남겨 동선이 섞이지 않는다
    const TECH = ["water_treatment", "storage", "linen_room", "laundry_room",
                  "waste_room", "core", "nurse_room", "consult_room"];
    // ── 배치 변형 축 (시드 난수) ──
    // 서로 독립인 축(골격 8가지) × 병상 대수 연동 실 크기 × 실별 크기 변형으로
    // 매번 다른 평면이 나온다. 어느 조합이든 규격·동선 규칙은 그대로 지켜진다.
    // 골격은 4비트 조합(16가지)으로 정의하고, 실행할 때마다 순환시켜
    // 연속으로 눌러도 같은 구성이 반복되지 않게 한다 (재귀 호출은 같은 조합 유지).
    const vbits = opts._variant ?? (variantSeq = (variantSeq + 1) & 31);
    const techSide = (vbits & 2) ? "left" : "right"; // ② 서비스 존(후방 밴드) 방향
    const corridorSide = (vbits & 4) ? "far" : "near"; // ③ 주 동선 위치
    const wantTwoCols = !!(vbits & 8);               // ④ 후방 밴드 2열 구성 선호
    // ④ N.S 위치: 상단 스트립 | 병상 필드와 환자 밴드 사이의 '중앙 아일랜드'
    //    (25BED 도면형 — 카운터가 필드 한가운데서 모든 병상 열을 마주본다)
    const nsIsland = !!(vbits & 16);
    // ① 배관 콘솔 방향: 가로(콘솔이 좌우로 지남) | 세로(27bed 팟 구조)
    //    최하위 비트라 실행할 때마다 가로·세로가 번갈아 나온다
    const bandAxis = (vbits & 1) ? "v" : "h";
    const hasWT = chosen.includes("water_treatment");
    const hasIso = chosen.includes("isolation_room");
    // 후방 밴드 적층 순서 (값이 작을수록 위 = 환자 출입구에서 먼 쪽).
    // 오염 계열(오물처리·세탁)을 밴드 '상단 외곽 코너'에 모은다 —
    // 환자 주 출입구(하단)와 대각으로 가장 멀고, 상단·측면 외벽에 바로 접해
    // 오물 반출·물품 입고를 외부에서 곧바로 처리할 수 있는 서비스 코너가 된다.
    // 그 아래로 청결(린넨·창고·코어) → 직원 지원(간호사실·상담) →
    // 최하단 정수실(소음원, 병상에서 최대 이격) 순으로 내려간다.
    const TECH_ORDER = {
      waste_room: -6, laundry_room: -5,
      linen_room: -3, storage: -2, core: -1,
      nurse_room: 2, consult_room: 3,
    };
    const techKeys = chosen.filter((k) => TECH.includes(k) && k !== "water_treatment")
      .sort((a, b) => (TECH_ORDER[a] ?? 9) - (TECH_ORDER[b] ?? 9));
    // 참고 도면 분석 ②: N.S는 병상 필드 안 'U자 아일랜드'로 독립 배치(별도 처리),
    // 간호처치실·조제실은 N.S와 같은 동선 쪽 끝에 인접시킨다.
    // 환자 밴드는 안쪽(직원 지원: 상담·과장)→환자 프런트(화장실→탈의→대기)→
    // 동선 쪽 끝(처치→조제) 순 — 환자 동선(출입구→대기→탈의→병상)과
    // 직원 동선(N.S↔조제/처치)이 교차하지 않는다.
    const hasNS = chosen.includes("nurse_station");
    // 출입구에서 먼 쪽(조제·처치) → 가까운 쪽(화장실→탈의→대기) 순.
    // 환자 대기실을 주 출입구 바로 옆에 두어 출입구와 직접 연결하고,
    // 환자 동선(출입구→대기→탈의→병상)이 순서대로 이어지게 한다.
    const PATIENT_ORDER = { pharmacy_room: 1, treatment_room: 2, toilet: 3, changing_room: 4, waiting_area: 5 };
    const patientKeys = shuffle(chosen.filter((k) =>
      !TECH.includes(k) && !["isolation_room", "water_treatment", "nurse_station"].includes(k)))
      .sort((a, b) => (PATIENT_ORDER[a] ?? 0) - (PATIENT_ORDER[b] ?? 0));

    // ── 부속시설 : 병상 필드 ≈ 1:1 면적 배분 — 실 크기를 배율 k로 확대 ──
    const allRoomKeys = [...techKeys, ...(hasWT ? ["water_treatment"] : []),
                         ...patientKeys, ...(hasIso ? ["isolation_room"] : [])];
    const baseArea = allRoomKeys.reduce((s, key) => s + bW(key) * bH(key), 0);
    const maxTechW0 = Math.max(0, ...techKeys.map(bW),
                               hasWT ? bW("water_treatment") : 0);
    // 병상 대수 우선 축소 시 환자 밴드 깊이 하한도 함께 낮춰 병상 필드를 넓힌다
    const maxPatH0 = Math.max(Math.round(250 * Math.max(shrink, 0.7) / 10) * 10, ...patientKeys.map(bH));
    // ── 배치 우선순위 ①: 장비(병상) 수량 우선 ──
    // 기본은 실을 부풀리지 않고 '제공된/기본 크기 그대로' 두어 병상 공간을 먼저 확보한다.
    // 목표 대수를 채운 뒤에만(_inflate) 남는 공간을 실에 돌려준다.
    const inflate = !!opts._inflate;
    let kScale = 1;
    if (inflate && baseArea > 0) {
      kScale = Math.sqrt((W * H * 0.5) / baseArea);
      kScale = Math.max(1, Math.min(kScale, (W * 0.35) / maxTechW0, (H * 0.4) / maxPatH0));
    }
    if (inflate) {
    // 확대 배율 상한: 선택한 실이 모두 들어가도록 제한한다
    // (세로) 후방 밴드 실 높이 합 + 환자 밴드 깊이 ≤ 병실 높이
    const sumTechH = [...techKeys, ...(hasWT ? ["water_treatment"] : [])]
      .reduce((s, key) => s + bH(key), 0);
    if (sumTechH + maxPatH0 > 0) {
      const avail = H - M * 2 - 10 * (techKeys.length + 2);
      kScale = Math.max(1, Math.min(kScale, avail / (sumTechH + maxPatH0)));
    }
    // (가로) 환자 밴드 실 폭 합 + 후방 밴드 폭 + 주 동선 ≤ 병실 폭
    const sumPatW = patientKeys.reduce((s, key) => s + bW(key), 0);
    if (sumPatW + maxTechW0 > 0) {
      const availW = W - M * 2 - 10 * (patientKeys.length + 1) - mainCw;
      kScale = Math.max(1, Math.min(kScale, availW / (sumPatW + maxTechW0)));
    }
    }
    // 단계 축소 중이면 확대하지 않는다
    if (shrink < 1) kScale = 1;
    const sdim = (v) => Math.round((v * kScale) / 10) * 10; // 10cm 단위로 스케일
    // 실별 배치 치수: 사용자 지정 실은 지정값 그대로, 나머지는 kScale 확대 적용
    const sW = (k) => (userSize(k) ? bW(k) : sdim(bW(k)));
    const sH = (k) => (userSize(k) ? bH(k) : sdim(bH(k)));

    // ── 기술 밴드: 측면 벽 세로 적층 (가로 폭 통일) ──
    // 조건 ②: 정수장치는 소음원이므로 병상 밀집 구역(상단 열)에서 가장 먼
    // 밴드 최하단 코너에 배치한다.
    // 열 폭·밴드 깊이: 자동 실은 kScale 확대, 사용자 지정 실은 지정값 그대로 반영
    const techAll = [...techKeys, ...(hasWT ? ["water_treatment"] : [])];
    const autoTechW = Math.max(0, ...techAll.filter((k) => !userSize(k)).map(bW));
    const userTechW = Math.max(0, ...techAll.filter((k) => userSize(k)).map(bW));
    const colW = maxTechW0 ? Math.max(autoTechW ? sdim(autoTechW) : 0, userTechW) : 0;
    const userPatH = Math.max(0, ...patientKeys.filter((k) => userSize(k)).map(bH));
    const autoPatH = Math.max(Math.round(250 * Math.max(shrink, 0.7) / 10) * 10,
                              ...patientKeys.filter((k) => !userSize(k)).map(bH));
    let patientBandH = Math.max(sdim(autoPatH), userPatH);
    /** 주어진 높이에 양면 밴드 n조(+단면 행)를 가장 빈틈없이 넣는 구성을 찾는다 */
    const planBands = (avail) => {
      const bH2 = moduleDepth * 2 + consoleDepth + 6;   // 양면 밴드 깊이
      const sH2 = consoleDepth + 6 + moduleDepth;       // 단면 행 깊이
      let best = { nb: 0, single: false, gaps: 0, waste: Math.max(0, avail) };
      for (let nb = 0; nb * bH2 <= avail; nb++) {
        [false, true].forEach((single) => {
          const rows = nb + (single ? 1 : 0);
          if (!rows) return;
          const used = nb * bH2 + (single ? sH2 : 0);
          const gaps = rows - 1;
          if (used + gaps * aisle > avail) return;
          const waste = avail - used - gaps * aisle;
          if (waste < best.waste) best = { nb, single, gaps, waste };
        });
      }
      return best;
    };
    // ── 죽은 공간 되돌리기: 병상 밴드가 쓰고 남을 높이를 환자 밴드가 흡수한다 ──
    // 통로만 무한정 넓히면 '넓은 빈 바닥'이 되므로, 통로 증가분은 요청 폭의 60%로
    // 제한하고 나머지는 실 면적(환자 밴드 깊이)으로 되돌린다.
    {
      const byEst = Math.max(M + 20, MEDICAL_RULES.FOOT_WALL_CLEARANCE_CM);
      const p = planBands(H - patientBandH - M - 130 - byEst);
      const spare = Math.max(0, p.waste - p.gaps * Math.round(aisle * 0.6));
      // 상한: 기본 깊이의 1.6배, 그리고 병실 높이의 35%까지 —
      // 환자 밴드가 무한정 깊어져 후방 밴드·병상 필드를 밀어내지 않도록 한다
      const capH = Math.min(Math.round(patientBandH * 1.6), Math.round(H * 0.35));
      patientBandH = Math.min(capH, patientBandH + Math.floor(spare / 10) * 10);
    }
    const TECH_AISLE = 130; // 후방 밴드 두 열 사이 내부 복도(1300mm)
    // 후방 실 높이 합이 한 열에 안 들어가면 2열 구성 (참고 도면의 후방 블록)
    const bandAvailH = H - patientBandH - M * 2 - 10;
    const techNeedH = [...techKeys, ...(hasWT ? ["water_treatment"] : [])]
      .reduce((s, key) => s + sH(key) + 10, 0);
    const fieldNeedW = 130 + mainCw + moduleWidth * 3;
    // 2열 구성: 한 열에 안 들어가면 필수, 들어가더라도 변형 축 ⑤가 선호하면 채택
    const twoColsFits = colW && W - (colW * 2 + TECH_AISLE) - M * 2 >= fieldNeedW;
    const techCols = (twoColsFits && (techNeedH > bandAvailH || wantTwoCols)) ? 2 : 1;
    const techBandW = colW ? colW * techCols + TECH_AISLE * (techCols - 1) : 0;

    // ── 병상 필드 경계 · 주 동선 (후방 밴드보다 먼저 확정) ──
    // 참고 도면 분석 ③: 모든 출입문을 통과하면 바로 '통로'가 되도록
    // 기술 밴드 문 앞 세로 복도와 환자 밴드 문 앞 가로 복도(각 130cm)를
    // 병상 금지 구역으로 확보한다 (도면의 동선 화살표 구간에 해당)
    const CD = consoleDepth;         // 배관 콘솔 두께
    const DOOR_CLEAR = 130;
    const fieldX0 = techSide === "left" ? techBandW + M + DOOR_CLEAR : M + 30;
    const fieldX1 = techSide === "right" ? W - techBandW - M - DOOR_CLEAR : W - 30;
    const fieldY1 = H - patientBandH - M - DOOR_CLEAR; // 환자 밴드 문 앞 복도 위까지
    // 동선-배관 분리 설계: 주 동선을 필드 '가장자리'에 두어 병상 열·콘솔·
    // 배관 주행선이 사람 이동 통로를 가로지르지 않게 한다.
    // 죽은 공간 제거: 병상 격자(피치)로 딱 떨어지지 않는 잔여 폭을 주 동선이
    // 흡수한다 — 필드 끝에 사람이 쓸 수 없는 자투리가 남지 않는다.
    // 주 동선은 '출입구에서 병상 필드 입구까지'만 확보한다 (corridor.y0 ~ H).
    // 필드 안에서는 밴드 사이 보조통로가 이동을 맡으므로, 세로 띠를 필드 끝까지
    // 비워 두면 그만큼 공간을 낭비하게 된다.
    const slackW = Math.max(0, ((fieldX1 - fieldX0) - mainCw) % moduleWidth);
    const mainCwFit = mainCw + Math.floor(slackW / 10) * 10;
    // 변형 축 ②: 주 동선을 후방 밴드 반대편(far) 또는 후방 밴드 쪽(near)에 둔다
    const corridorAtRight = (techSide === "left") === (corridorSide === "far");
    const corridor = corridorAtRight
      ? { x0: fieldX1 - mainCwFit, x1: fieldX1, y0: fieldY1 }
      : { x0: fieldX0, x1: fieldX0 + mainCwFit, y0: fieldY1 };

    // ── 간호처치실·조제실은 N.S에 붙인다 (업로드 도면 27bed 구성) ──
    // 처치·투약 준비는 스테이션 업무의 연장이므로 N.S에서 바깥쪽으로
    // [N.S][간호처치실][조제실] 순으로 벽을 공유하며 이어 붙인다.
    // 간호사실(탈의·휴게)은 근무 공간이 아니므로 후방 밴드에 떨어져 있어도 된다.
    // 상단 스트립(격리실 + N.S + 처치·조제)을 빼고도 병상 모듈 2개 폭이 남아야 한다.
    // N.S 아일랜드 폭 = 좌우 카운터 팔(40×2) + 데스크 1열 + 여유 (addStationIsland와 동일 식)
    const nsW0 = 90 + Math.min(4, Math.ceil(stationSeats / 2)) * MEDICAL_RULES.NS_DESK_PITCH_CM;
    const isoW0 = hasIso ? Math.max(bW("isolation_room"), moduleWidth + 60) : 0;
    // 스트립에서 격리실·N.S를 뺀 나머지 폭. 처치실·조제실의 스테이션 인접이
    // 우선이므로 병상 자리를 미리 예약하지 않는다 — 스트립이 가득 차면
    // 병상 밴드는 스트립 아래 전폭에서 시작한다(bandsBelowStrip).
    const stripAvailW = Math.floor(
      ((fieldX1 - fieldX0) - (isoW0 ? isoW0 + 45 : 0) - (nsW0 + 45) - 45) / 10) * 10;
    // N.S에 가까운 순서: 처치실 → 조제실. 폭이 모자라면 좁혀서라도 붙이고,
    // 남은 폭이 최소치(2,000mm) 미만이면 그 실은 환자 밴드에 남긴다.
    const stripPlan = [];
    if (hasNS && !lockedHas("nurse_station")) {
      let left = stripAvailW;
      // 간호처치실이 항상 N.S에 먼저 붙고 그 바깥에 조제실이 이어진다
      ["treatment_room", "pharmacy_room"].forEach((key) => {
        if (!chosen.includes(key) || lockedHas(key) || left < 200) return;
        const w = Math.min(bW(key), left);
        stripPlan.push({ key, w });
        left -= w;
      });
    }
    const inStrip = (k) => stripPlan.some((r) => r.key === k);
    let serviceDoor = null; // 오물 반출·물품 입고용 외부 출입구 위치
    {
      const tx = techSide === "left" ? M : W - techBandW - M;
      // 열(column) 좌표: col 0 = 외벽 쪽, col 1 = 안쪽. 두 열 사이는 내부 복도.
      const colX = (c) => techSide === "left"
        ? tx + c * (colW + TECH_AISLE)
        : tx + techBandW - colW - c * (colW + TECH_AISLE);
      /**
       * 후방 밴드 실의 벽면 문 — 벽 길이의 중앙에 단다.
       * kind : 문 종류, c : 열 번호, ty/h : 실의 세로 위치·높이
       * opts.outer : true면 외벽 쪽 변, 기본은 복도(또는 병상 필드) 쪽 변
       * opts.width : 문 폭(cm) 재정의 — 예) 정수실 장비 반입용 1000mm
       * opts.outward : true면 바깥여닫이 — 정수실처럼 실 안쪽에 문짝을
       *   젖힐 공간이 없는 실에 쓴다 (roomSide를 반대로 줘서 문짝을 밖으로 그린다)
       * 반환값은 문 앞 금지 구역(오브젝트 배치 회피용)
       *
       * 문 앵커 보정: angle 90은 앵커 기준 왼쪽·아래로, 270은 오른쪽·위로
       * 그려진다(fabric 실측). 그래서 오른쪽 변은 90°, 왼쪽 변은 270°를 쓴다.
       */
      const wallDoor = (kind, c, ty, h, opts = {}) => {
        const dl = opts.width ?? doorData[kind].width;
        const my = ty + Math.round(h / 2);                  // 벽면 세로 중앙
        const innerIsRight = techSide === "left";           // 복도 쪽이 오른쪽 변인가
        const onRight = opts.outer ? !innerIsRight : innerIsRight;
        const edge = onRight ? colX(c) + colW : colX(c);
        // 실 기준: 오른쪽 벽이면 roomSide "right"(실이 왼쪽) → 안쪽으로 열림
        // outward면 반대 변을 실로 간주해 문짝이 실 밖으로 젖혀지게 한다
        const swingRight = opts.outward ? !onRight : onRight;
        addDoor(kind, {
          anchor: { x: edge, y: my }, roomSide: swingRight ? "right" : "left",
          width: opts.width, silent: true,
        });
        return onRight
          ? { x0: edge - 110, x1: edge + 5, y0: my - dl / 2 - 10, y1: my + dl / 2 + 10 }
          : { x0: edge - 5, x1: edge + 110, y0: my - dl / 2 - 10, y1: my + dl / 2 + 10 };
      };

      // 정수실: 외벽 열(col 0) 맨 아래 — 환자에게서 가장 먼 코너
      let wtTop = H - patientBandH - M;
      if (hasWT && !lockedHas("water_treatment")) {
        const wtH = sH("water_treatment");
        wtTop = H - patientBandH - M - wtH;
        addEquipment("water_treatment", { left: colX(0), top: wtTop, width: colW, height: wtH, silent: true });
        // 정수실 문: 탱크·RO 반입을 위해 1000mm 폭, 벽면 중앙.
        // RO 유닛·염수탱크가 벽면을 채워 문짝을 안으로 젖힐 수 없다 → 바깥여닫이
        const wtZone = wallDoor("swing_door", 0, wtTop, wtH, { width: 100, outward: true });
        populateRoom("water_treatment", colX(0), wtTop, colW, wtH, [wtZone]);
      }
      // 나머지 후방 실은 정수실 위에서부터 아래→위로 적층하고,
      // 열이 차면 안쪽 열(col 1)로 넘어간다 — 두 열 사이는 내부 복도.
      // 상단(오염: 오물·세탁·세척) → 중간(청결: 린넨·창고·코어) →
      // 하단(직원 지원 + 정수실) 순으로 내려간다.
      // ① 실을 열(column)에 미리 배분: 위(오염)부터 col0 → 넘치면 col1
      const colAvail = [wtTop - M, techCols > 1 ? H - patientBandH - M * 2 : 0];
      // 실 누락 방지: 후방 실 높이 합이 열 용량을 넘으면 비례 축소해 전부 수용한다.
      // (선택한 실이 조용히 사라지지 않도록 — 남는 높이는 아래 ②에서 재배분)
      // 크기를 직접 지정한 실은 축소 대상에서 빼고, 자동 실만 비례 축소한다
      const techCap = colAvail[0] + colAvail[1];
      const fixedNeed = techKeys.filter((k) => userSize(k)).reduce((s, k) => s + sH(k), 0);
      const flexNeed = techKeys.filter((k) => !userSize(k)).reduce((s, k) => s + sH(k), 0);
      const flexCap = Math.max(0, techCap - fixedNeed);
      const techFit = flexNeed > flexCap && flexCap > 0 ? flexCap / flexNeed : 1;
      /** 후방 밴드 배치 높이 — 용량 초과 시 축소, 최소 1,500mm는 보장 */
      const tH = (k) => (userSize(k) ? sH(k)
        : Math.max(150, Math.round((sH(k) * techFit) / 10) * 10));
      const colRooms = [[], []];
      let ci = 0;
      // 오물처리실은 2열 구성에서도 반드시 외벽 열(col 0) 최상단에 자리를 예약한다 —
      // 상단 외벽 + 측면 외벽 두 면에 접하는 코너가 되어 오물 반출·물품 입고가
      // 실내를 거치지 않고 외부에서 바로 이루어진다.
      const reserveWaste = techCols > 1 && techKeys.includes("waste_room");
      const wasteH = reserveWaste ? tH("waste_room") : 0;
      // col 0의 가용 높이에서 예약분을 뺀 값 (col 1은 예약 없음)
      const capOf = (c) => colAvail[c] - (c === 0 ? wasteH : 0);
      [...techKeys].reverse().forEach((key) => { // office → … → waste 순 (아래→위)
        if (reserveWaste && key === "waste_room") return; // 아래에서 col 0 최상단에 추가
        const h = tH(key);
        // 현재 열에 안 들어가면 다음 열로 넘긴다 (두 열 모두 안 되면 이번 구성에서 제외)
        for (let c = ci; c < techCols; c++) {
          if (colRooms[c].reduce((s, r) => s + r.h, 0) + h <= capOf(c)) {
            colRooms[c].push({ key, h, fixed: !!userSize(key) });
            ci = c;
            return;
          }
        }
      });
      // 리스트 마지막 = 열의 최상단 (아래에서 위로 쌓기 때문)
      if (reserveWaste) {
        colRooms[0].push({ key: "waste_room", h: wasteH, fixed: !!userSize("waste_room") });
      }
      // ② 각 열의 남는 높이를 실들에 배분해 '정확히' 채운다 — 틈·빈 공간 0.
      //    사용자가 크기를 지정한 실(fixed)은 그대로 두고 자동 실에만 배분하되,
      //    모든 실이 지정 크기라면 틈 방지가 우선이므로 전체에 배분한다.
      colRooms.forEach((list, c) => {
        if (!list.length) return;
        const flex = list.filter((r) => !r.fixed);
        const pool = flex.length ? flex : list;
        const extra = colAvail[c] - list.reduce((s, r) => s + r.h, 0);
        const per = Math.floor(extra / pool.length / 10) * 10;
        pool.forEach((r) => { r.h += per; });
        pool[pool.length - 1].h += colAvail[c] - list.reduce((s, r) => s + r.h, 0); // 잔여 흡수
        // ③ 아래에서 위로 벽을 공유하며 배치
        let ty = c === 0 ? wtTop : H - patientBandH - M;
        list.forEach(({ key, h }) => {
          ty -= h;
          if (lockedHas(key) || hitLocked(colX(c), ty, colW, h)) { ty += h; return; } // 잠금 보존/회피
          addEquipment(key, { left: colX(c), top: ty, width: colW, height: h, silent: true });
          const zones = [];
          if (key === "waste_room") {
            // 오물처리실: 미닫이문(벽면 중앙), 내부 복도 + 외벽 양방향 출구
            zones.push(wallDoor("sliding_door", c, ty, h));
            if (c === 0) zones.push(wallDoor("sliding_door", c, ty, h, { outer: true }));
            // 상단 외벽에 접하면 반출입(서비스) 전용 문을 추가로 낸다 —
            // 오물 반출·물품 입고가 실내를 거치지 않고 외부로 바로 연결된다
            if (ty <= M + 15) {
              const sx = colX(c) + Math.round(colW / 2);
              addDoor("sliding_door", { anchor: { x: sx, y: ty }, roomSide: "top", silent: true });
              zones.push({ x0: sx - 80, x1: sx + 80, y0: ty - 5, y1: ty + 110 });
              serviceDoor = { x: sx, y: ty };
            }
          } else {
            zones.push(wallDoor("swing_door", c, ty, h));
          }
          populateRoom(key, colX(c), ty, colW, h, zones);
        });
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
        // 후방 복도 폭 치수
        dimLine("h", zx, zx + TECH_AISLE - 4, M + 70, "#616161");
      }
    }

    // ── 후방 밴드 문 앞 세로 복도 표기 ──
    // 후방 실 문을 나서면 바로 통로가 되는 구간(DOOR_CLEAR)을 동선으로 명시한다.
    // 표기가 없으면 도면상 '빈 바닥'처럼 보이지만 실제로는 지원 동선이다.
    if (techBandW) {
      const cx = techSide === "left" ? techBandW + M : W - techBandW - M - DOOR_CLEAR;
      const zone = new fabric.Rect({
        left: cx + 2, top: M + 10, width: DOOR_CLEAR - 4,
        height: H - patientBandH - M * 2 - 10,
        fill: "rgba(120,144,156,0.10)", stroke: "#78909C",
        strokeWidth: 1.5, strokeDashArray: [12, 10],
        selectable: false, evented: false,
      });
      zone.meta = { key: "annotation", label: "후방 실 앞 통로" };
      canvas.add(zone);
    }

    // ── 반출입(서비스) 동선 표기: 오물처리실 ↔ 외부 ──
    // 환자 주 출입구(하단)와 대각으로 분리된 상단 코너에서 오물 반출·물품 입고가
    // 이루어짐을 화살표와 라벨로 명시한다 (청결/오염 동선 교차 방지)
    if (serviceDoor) {
      const out = new fabric.Triangle({
        left: serviceDoor.x, top: serviceDoor.y - 55, width: 34, height: 44, angle: 180,
        originX: "center", originY: "center",
        fill: "rgba(109,76,65,0.7)", selectable: false, evented: false,
      });
      out.meta = { key: "annotation", label: "반출입 동선" };
      canvas.add(out);
      const t = new fabric.Text("반출입구 (오물 반출 · 물품 입고)", {
        left: serviceDoor.x, top: serviceDoor.y - 100, fontSize: 20, fill: "#6D4C41",
        originX: "center", selectable: false, evented: false,
      });
      t.meta = { key: "annotation", label: "반출입구" };
      canvas.add(t);
    }

    // ── 주 출입구: 주 동선 폭의 한가운데, 하단 외벽에 자동문 ──
    const entranceX = Math.round((corridor.x0 + corridor.x1) / 2);
    addDoor("auto_door", { anchor: { x: entranceX, y: H }, roomSide: "bottom", silent: true });

    // ── 환자 밴드: 하단 벽 가로 배치 (세로 깊이 통일) ──
    // 배치 순서: 안쪽(조제·처치) → 출입구 쪽(화장실→탈의→대기).
    // 대기실이 주 출입구 바로 옆에 와서 출입구와 직접 연결된다.
    {
      // 환자 밴드는 후방 밴드 '아래' 구역까지 포함해 하단 전폭을 쓴다 —
      // 후방 밴드는 환자 밴드 위에서 끝나므로 그 아래를 비워두면 죽은 공간이 된다.
      // 주 동선 구간만 비우고 그 너머로 이어서 채운다.
      const bandX0 = M + 30;
      const xMax = W - 30;
      // 주 동선이 밴드를 가로지르는 구간 (이 구간은 건너뛴다)
      const gapX0 = corridor.x0 - 10, gapX1 = corridor.x1 + 10;
      const usableW = (xMax - bandX0) - (gapX1 - gapX0);
      // 간호처치실·조제실이 N.S 옆 스트립으로 올라간 경우 환자 밴드에서는 제외한다
      const bandKeys = patientKeys.filter((k) => !inStrip(k));
      // 주 동선이 왼쪽이면 출입구부터 채우므로 순서를 뒤집는다 (대기실이 출입구 옆)
      const orderKeys = corridorAtRight ? [...bandKeys] : [...bandKeys].reverse();
      // 폭 부족 시 출입구에서 먼 실(조제·처치)부터 제외해 대기·탈의실을 보장
      const fitKeys = [...orderKeys];
      while (fitKeys.length &&
             fitKeys.reduce((s, key) => s + sW(key) + 10, 0) > usableW) {
        if (corridorAtRight) fitKeys.shift(); else fitKeys.pop();
      }
      // 남는 폭을 각 실에 비례 배분해 밴드를 정확히 채운다 —
      // 실 사이 틈(사람이 지나갈 수 없는 슬리버)과 빈 공간을 없앤다
      const baseW = fitKeys.reduce((s, key) => s + sW(key), 0);
      const slack = Math.max(0, usableW - baseW);
      // 남는 폭은 크기를 지정하지 않은 실에만 배분한다 (모두 지정이면 전체 배분)
      const growKeys = fitKeys.filter((k) => !userSize(k));
      const growPool = growKeys.length ? growKeys : fitKeys;
      const grow = growPool.length ? Math.floor(slack / growPool.length / 10) * 10 : 0;

      let px = bandX0;
      fitKeys.forEach((key, i) => {
        if (lockedHas(key)) return; // 잠긴 동일 실이 있으면 새로 만들지 않는다
        // 마지막 실은 남은 폭을 모두 흡수해 밴드 끝까지 붙인다 (틈 방지 우선)
        let w = i === fitKeys.length - 1
          ? Math.max(sW(key), xMax - px)
          : sW(key) + (growPool.includes(key) ? grow : 0);
        const roomTop = H - patientBandH - M;
        // 주 동선 구간에 걸치면 통째로 건너뛴다 (출입구 앞을 막지 않는다)
        if (px < gapX1 && px + w > gapX0) {
          if (px < gapX0 && gapX0 - px >= 150) w = gapX0 - px;   // 앞쪽에 실이 들어갈 만하면 잘라 쓰고
          else px = gapX1;                                        // 아니면 통로 너머로 넘어간다
          if (i === fitKeys.length - 1) w = Math.max(sW(key), xMax - px);
        }
        const hz = hitLocked(px, roomTop, w, patientBandH);
        if (hz) px = Math.round((hz.x1 + 5) / 10) * 10; // 잠금 구역 뒤로 밀어 배치
        if (px + w > xMax + 1) return;
        addEquipment(key, { left: px, top: roomTop, width: w, height: patientBandH, silent: true });
        const zones = [];
        if (key === "waiting_area") {
          // 대기실은 주 출입구와 직접 연결 — 주 동선 쪽 벽에 양짝문
          const dl = doorData.double_swing_door.width;
          const my = roomTop + Math.round(patientBandH / 2);
          const onRight = corridorAtRight; // 주 동선 쪽 벽에 단다
          const edge = onRight ? px + w : px;
          addDoor("double_swing_door", {
            anchor: { x: edge, y: my }, roomSide: onRight ? "right" : "left", silent: true,
          });
          zones.push(onRight
            ? { x0: edge - 200, x1: edge + 5, y0: my - dl / 2 - 10, y1: my + dl / 2 + 10 }
            : { x0: edge - 5, x1: edge + 200, y0: my - dl / 2 - 10, y1: my + dl / 2 + 10 });
        } else {
          // 그 외 실: 위쪽 변(복도 쪽) 중앙에 달고 실 내부(아래)로 열리는 문
          const mx = px + Math.round(w / 2);
          addDoor("swing_door", { anchor: { x: mx, y: roomTop }, roomSide: "top", silent: true });
          zones.push({ x0: mx - 60, x1: mx + 60, y0: roomTop - 5, y1: roomTop + 110 });
        }
        populateRoom(key, px, roomTop, w, patientBandH, zones);
        px += w; // 실끼리 벽을 공유 — 사이에 빈 틈을 만들지 않는다
      });
    }

    // ── 격리실: 기술 밴드 반대편 상단 코너 (+격리 병상) ──
    let isoZone = null;
    let isoBedGrp = null;
    const placedBeds = [];
    if (hasIso && lockedHas("isolation_room")) {
      const li = lockedObjs.find((o) => o.meta.key === "isolation_room");
      const r = li.getBoundingRect(true);
      isoZone = { left: r.left, right: r.left + r.width, top: r.top, bottom: r.top + r.height };
      isoBedGrp = lockedObjs.find((o) => o.meta.key === "bed_unit" && o.meta.isolated) ?? null;
    } else if (hasIso) {
      // 격리실은 병상 모듈 + 머리맡 40cm + 발쪽 이격 800mm이 들어가도록 키운다
      const isoW = Math.max(bW("isolation_room"), moduleWidth + 60);
      const isoH = Math.max(bH("isolation_room"), 40 + moduleDepth + MEDICAL_RULES.FOOT_WALL_CLEARANCE_CM + 10);
      // 격리실은 주 동선 반대편 코너 — 스트립이 [격리실][N.S][처치][조제] 순으로
      // 주 동선 쪽을 향해 이어지고, 감염 구역이 주 출입 동선에서 가장 멀어진다
      // 필드 경계 안쪽에 두어 후방 밴드와 사이에 통로(DOOR_CLEAR)가 남게 한다 —
      // 후방 실과 격리실 사이에 사람이 못 지나는 좁은 틈이 생기지 않는다
      const ix = corridorAtRight ? fieldX0 : fieldX1 - isoW;
      addEquipment("isolation_room", { left: ix, top: M, width: isoW, height: isoH, silent: true });
      // 격리실 문: 아래쪽 벽(병상 필드 쪽) 중앙 미닫이
      const isoDx = ix + Math.round(isoW / 2);
      addDoor("sliding_door", { anchor: { x: isoDx, y: M + isoH }, roomSide: "bottom", silent: true });
      populateRoom("isolation_room", ix, M, isoW, isoH,
        [{ x0: isoDx - 80, x1: isoDx + 80, y0: M + isoH - 110, y1: M + isoH + 5 }]); // 미닫이문 회피
      if (placedBeds.length < target) {
        isoBedGrp = addBedUnit(ix + 30, M + 40, true);
        placedBeds.push({ grp: isoBedGrp, rowY: M + 40 });
      }
      isoZone = { left: ix, right: ix + isoW, top: M, bottom: M + isoH };
    }

    // ── N.S 아일랜드: 병상 필드 상단, 주 동선 옆 (참고 도면의 U자 카운터) ──
    // 개방면이 병상 쪽(아래)을 향해 모든 병상 열을 한눈에 관찰하고,
    // 주 동선에 접해 있어 출입구·처치실·조제실과의 동선이 짧다.
    // 상단 스트립 = [격리실(코너)] + [N.S 아일랜드]. 남는 폭이 모듈 2개 미만이면
    // 병상 밴드를 스트립 아래 전폭에서 시작해 파편·빈 포켓을 만들지 않는다.
    let nsZone = null;
    let stripBottom = isoZone ? isoZone.bottom : 0;
    // 중앙 아일랜드형: 병상 필드 맨 아래(환자 밴드 문 앞 복도 바로 위)에 카운터 열을
    // 두고 병상 밴드는 그 위쪽에서만 형성된다 — 카운터가 전 병상을 정면으로 마주본다.
    const islandH = Math.max(MEDICAL_RULES.NS_DEPTH_CM,
      40 + MEDICAL_RULES.NS_ENTRY_CM + equipmentData.station_desk2.height);
    const useIsland = hasNS && nsIsland && !lockedHas("nurse_station")
      && fieldY1 - (M + 20) > islandH + aisle + moduleDepth * 2 + consoleDepth;
    const stripTop = useIsland ? fieldY1 - islandH : M + 20;
    // 병상 밴드가 쓸 수 있는 아래 한계 (아일랜드형이면 카운터 위까지)
    const bandY1 = useIsland ? stripTop - aisle : fieldY1;
    if (hasNS && lockedHas("nurse_station")) {
      const ln = lockedObjs.find((o) => o.meta.key === "nurse_station");
      const r = ln.getBoundingRect(true);
      nsZone = { left: r.left, right: r.left + r.width, top: r.top, bottom: r.top + r.height };
      stripBottom = Math.max(stripBottom, nsZone.bottom);
    } else if (hasNS) {
      const nsW = nsW0; // 1열 배치 폭 (스트립 폭 계산과 동일 식)
      // 격리실 안쪽(주 동선 쪽)에 바로 붙인다
      // 격리실 벽에 밀착 — 사이에 사람이 못 지나는 좁은 틈(300mm)을 만들지 않는다
      // 아일랜드형: N.S를 필드 바깥쪽 끝에 붙이고 스트립이 주 동선 쪽으로 이어져
      // 열 전체가 필드를 가로지른다 — 카운터 옆에 빈 바닥이 남지 않는다
      let nsX = useIsland
        ? (corridorAtRight ? fieldX0 : fieldX1 - nsW)
        : (isoZone
            ? (corridorAtRight ? isoZone.right : isoZone.left - nsW)
            : (corridorAtRight ? corridor.x0 - nsW - 20 : corridor.x1 + 20));
      const nsY = stripTop;
      // 스트립(처치·조제)이 붙을 폭까지 확보한 위치로 클램프 —
      // N.S만 밀려나 스트립과 떨어지는 일이 없도록 한다
      // 스트립이 자라는 쪽에 필요한 폭을 반드시 남긴다 — 처치·조제실이
      // 자리를 못 잡고 사라지는 일이 없도록 한다 (growLeft = !corridorAtRight)
      const needStrip = stripPlan.reduce((a, r) => a + r.w, 0);
      nsX = corridorAtRight
        ? Math.min(nsX, fieldX1 - nsW - needStrip)
        : Math.max(nsX, fieldX0 + needStrip);
      nsX = Math.max(fieldX0, Math.min(nsX, fieldX1 - nsW));
      // 출입 개구부는 처치실이 붙는 쪽 팔에 — 처치실↔스테이션 이동이 최단
      const ns = addStationIsland(nsX, nsY, stationSeats, corridorAtRight ? "right" : "left");
      nsZone = { left: nsX, right: nsX + ns.w, top: nsY, bottom: nsY + ns.h };
      stripBottom = Math.max(stripBottom, nsZone.bottom);
      // 관찰 시야 표시: 개방면(아래)에서 병상 필드로 향하는 시야각
      const eye = new fabric.Text(useIsland ? "△ 관찰 시야" : "▽ 관찰 시야", {
        left: nsX + ns.w / 2, top: useIsland ? nsY - 28 : nsY + ns.h + 6,
        fontSize: 20, fill: "#E65100",
        originX: "center", selectable: false, evented: false,
      });
      eye.meta = { key: "annotation", label: "N.S 관찰 시야" };
      canvas.add(eye);
    }
    // ── 간호처치실·조제실: N.S에서 바깥쪽으로 이어 붙여 스테이션과 직결 ──
    // techSide=left면 스트립이 오른쪽 벽에 붙으므로 N.S 왼쪽으로,
    // techSide=right면 오른쪽으로 [N.S][처치실][조제실] 순으로 벽을 공유한다.
    const stripZones = [];
    if (nsZone && stripPlan.length) {
      // 스트립 높이(격리실·N.S 중 깊은 쪽)에 맞춰 아래 병상 밴드와 라인을 맞춘다
      const rowH = useIsland ? islandH
        : Math.max(stripBottom - M, ...stripPlan.map((r) => bH(r.key)));
      // 스트립은 N.S에서 주 동선 쪽으로 이어 붙인다 (격리실 → N.S → 처치 → 조제)
      const growLeft = !corridorAtRight;
      let edge = growLeft ? nsZone.left : nsZone.right;
      stripPlan.forEach(({ key, w }) => {
        // 남는 폭에 맞춰 줄여서라도 붙인다 — 스테이션과 떨어지지 않게 한다
        const limit = useIsland ? (growLeft ? corridor.x1 + 10 : corridor.x0 - 10)
                                : (growLeft ? fieldX0 : fieldX1);
        const avail = growLeft ? edge - limit : limit - edge;
        // 아일랜드형은 마지막 실이 남은 폭을 모두 흡수해 열을 끝까지 채운다
        const isLast = key === stripPlan[stripPlan.length - 1].key;
        const ww = (useIsland && isLast)
          ? Math.floor(avail / 10) * 10
          : Math.min(w, Math.floor(avail / 10) * 10);
        if (ww < 120) return;                       // 1,200mm 미만이면 이 구성에선 생략
        const rx = growLeft ? edge - ww : edge;
        if (hitLocked(rx, stripTop, ww, rowH)) return;
        w = ww;
        addEquipment(key, { left: rx, top: stripTop, width: w, height: rowH, silent: true });
        // 문은 병상 필드 쪽 벽 중앙 — 스테이션과 바로 통한다
        // (상단 스트립이면 아래쪽 변, 중앙 아일랜드면 위쪽 변이 필드 쪽)
        const dx = rx + Math.round(w / 2);
        const dy = useIsland ? stripTop : stripTop + rowH;
        addDoor("swing_door", { anchor: { x: dx, y: dy },
          roomSide: useIsland ? "top" : "bottom", silent: true });
        populateRoom(key, rx, stripTop, w, rowH, [useIsland
          ? { x0: dx - 70, x1: dx + 70, y0: stripTop - 5, y1: stripTop + 110 }
          : { x0: dx - 70, x1: dx + 70, y0: stripTop + rowH - 110, y1: stripTop + rowH + 5 }]);
        stripZones.push({ key, left: rx, right: rx + w, top: stripTop, bottom: stripTop + rowH });
        stripBottom = Math.max(stripBottom, stripTop + rowH);
        edge = growLeft ? rx : rx + w; // 다음 실은 이 실의 바깥쪽에 붙는다
      });
    }

    // 스트립이 차지하고 남는 상단 폭 계산 → 모듈 2개 미만이면 밴드는 아래에서 시작
    const stripUsed = (isoZone ? isoZone.right - isoZone.left + 45 : 0) +
                      (nsZone ? nsZone.right - nsZone.left + 45 : 0) +
                      stripZones.reduce((s, z) => s + (z.right - z.left) + 45, 0);
    // 스트립 아래에서 시작하려면 '거기에 밴드 한 조가 들어갈 때'만 — 안 들어가면
    // 상단부터 시작한다. 배치 범위를 행 단위로 계산하므로 스트립과 겹치는 행만
    // 좁아지고 그 아래 행은 필드 전폭을 쓴다 (병상 수가 0이 되는 것을 막는다).
    const bandsBelowStrip = !useIsland && stripBottom > 0 &&
      (fieldX1 - fieldX0) - stripUsed < moduleWidth * 2 + 40 &&
      fieldY1 - (stripBottom + Math.max(aisle, 100)) >= moduleDepth * 2 + consoleDepth;

    // ── 병상 필드: 콘솔 양면(back-to-back) 밴드 구조 ──
    // 조건 ④: 하나의 배관 콘솔을 사이에 두고 위(머리↓)/아래(머리↑) 양방향으로
    // 병상 유닛을 설치한다. 밴드 피치 = 병상 + 콘솔 + 병상 + 통로.
    // 병상 모듈(침대+투석기 존)은 서로 붙여 배치: 피치 = 모듈 폭
    // (참고 도면의 1800mm 병상 피치 — 침대 사이는 장비 존으로 분리)
    const MW = moduleWidth, MD = moduleDepth;
    const pitch = MW;

    /** 한 행 채우기: 통로·격리실을 피해 좌→우로 병상 유닛 배치 */
    /** 지정한 세로 구간에서 격리실·N.S 아일랜드를 피한 병상 배치 가능 x 범위 */
    const boundsFor = (yTop, yBottom) => {
      let rx0 = fieldX0, rx1 = fieldX1;
      // 상단 스트립(격리실·N.S·처치실·조제실)은 한쪽 벽에 붙어 이어지므로 하나의
      // 구간으로 합쳐서 잘라낸다 — 사이사이에 병상을 끼워 넣어 조각내지 않는다
      // 실제로 세로 구간이 겹치는 스트립만 잘라낸다 (여유 5cm) —
      // 스트립 바로 아래 행까지 좁아져 병상이 사라지는 것을 막는다
      const hit = [isoZone, nsZone, ...stripZones]
        .filter((z) => z && yBottom > z.top + 5 && yTop < z.bottom - 5);
      if (hit.length) {
        const left = Math.min(...hit.map((z) => z.left));
        const right = Math.max(...hit.map((z) => z.right));
        if ((left + right) / 2 > (fieldX0 + fieldX1) / 2) rx1 = Math.min(rx1, left - 45);
        else rx0 = Math.max(rx0, right + 45);
      }
      return { rx0, rx1 };
    };

    // 모듈 격자: 모든 행이 같은 위상(fieldX0 + k·pitch)을 쓰므로, 행마다
    // 배치 범위가 달라도 병상이 세로로 정확히 정렬된다 — 콘솔 건너편 병상과의
    // 대각선 간격이 좁아지지 않으면서, 스트립 아래 남는 폭까지 채울 수 있다.
    const gridX0 = fieldX0;
    const snapGrid = (x) => gridX0 + Math.ceil((x - gridX0 - 0.5) / pitch) * pitch;

    const fillRow = (yBed, headDown, bounds) => {
      const { rx0, rx1 } = bounds ?? boundsFor(yBed, yBed + MD);
      const row = [];
      let x = snapGrid(rx0);
      while (x + MW <= rx1) { // 목표 대수와 무관하게 행을 끝까지 채운다
        if (corridor && yBed + MD > corridor.y0 &&
            x + MW > corridor.x0 && x < corridor.x1) {
          x = snapGrid(corridor.x1 + 10); // 주 동선 통로는 비운다 (격자 위상 유지)
          continue;
        }
        const lz = hitLocked(x, yBed, MW, MD);
        if (lz) { // 잠긴 객체 구역은 건너뛴다
          x = snapGrid(lz.x1 + 5);
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
    // 첫 밴드 위 행은 발쪽이 상단 벽을 향하므로 발-벽 이격 800mm을 확보하고 시작.
    // N.S 아일랜드가 필드 폭의 절반 이상을 차지하면 옆에 병상을 끼우는 대신
    // 상단 띠를 통째로 스테이션에 내주고 병상 밴드는 그 아래에서 시작한다.
    let by = Math.max(M + 20, MEDICAL_RULES.FOOT_WALL_CLEARANCE_CM);
    if (bandsBelowStrip) {
      by = stripBottom + Math.max(aisle, 100); // 스트립 아래 전폭에서 시작 (회피 불필요)
    }
    // ── 죽은 공간 최소화: 밴드 구성을 '탐색'해서 가장 많이 채우는 조합을 고른다 ──
    // 양면 밴드 n조 (+ 단면 행 1개) 조합 중 잔여 높이가 가장 작은 것을 택하고,
    // 그래도 남는 높이는 통로에 균등 배분해 자투리 띠를 없앤다.
    const bandH = MD + CD + 6 + MD;              // 양면 밴드 한 조의 깊이
    const singleH = CD + 6 + MD;                 // 단면 행(콘솔 + 한 줄) 깊이
    const availBandH = bandY1 - by;
    const plan = planBands(availBandH);
    // 남는 높이를 통로에 배분하되 요청 폭의 60%까지만 넓힌다
    const aisleFit = plan.gaps > 0
      ? aisle + Math.min(Math.round(aisle * 0.6),
          Math.floor(plan.waste / plan.gaps / 10) * 10)
      : aisle;
    // ═══ 세로 콘솔 배치 (27bed 팟 구조) ═══
    // 콘솔이 세로로 지나가고 좌우에 병상이 마주본다. 밴드는 좌→우로 반복되며
    // 각 열의 병상은 위→아래로 쌓인다.
    if (bandAxis === "v") {
      const bandW = MD + CD + 6 + MD;              // 밴드 가로 폭
      const colTop = by;                            // 병상 열 시작 y
      const colBot = bandY1;                        // 끝 y
      /** 세로 구간에서 스트립을 피한 y 범위 (가로로 겹치는 스트립만 잘라낸다) */
      const vBounds = (xL, xR) => {
        let ry0 = colTop, ry1 = colBot;
        [isoZone, nsZone, ...stripZones]
          .filter((z) => z && xR > z.left + 5 && xL < z.right - 5)
          .forEach((z) => {
            if (z.bottom < (colTop + colBot) / 2) ry0 = Math.max(ry0, z.bottom + 45);
            else ry1 = Math.min(ry1, z.top - 45);
          });
        return { ry0, ry1 };
      };
      /** 한 열 채우기: 위→아래로 병상 유닛 배치 (격자 위상 공유) */
      const gridY0 = colTop;
      const fillCol = (xBed, headLeft) => {
        const { ry0, ry1 } = vBounds(xBed, xBed + MD);
        const col = [];
        let y = gridY0 + Math.ceil((ry0 - gridY0 - 0.5) / MW) * MW;
        while (y + MW <= ry1) {
          const lz = hitLocked(xBed, y, MD, MW);
          if (lz) { y = gridY0 + Math.ceil((lz.y1 + 5 - gridY0) / MW) * MW; continue; }
          const grp = addBedUnitV(xBed, y, false, headLeft);
          col.push(grp);
          placedBeds.push({ grp, rowY: y });
          y += MW;
        }
        return col;
      };
      /** 세로 콘솔 스트립: 두 열의 병상 구간을 합쳐 깐다 */
      const layConsoleV = (cx, bedsLR) => {
        if (!bedsLR.length) return;
        const y0 = Math.min(...bedsLR.map((b) => b.top)) - 15;
        const y1 = Math.max(...bedsLR.map((b) => b.top + b.height)) + 15;
        addEquipment("bed_console", {
          left: cx, top: y0, width: CD, height: y1 - y0, silent: true,
        });
      };
      // 밴드 개수 계산 + 남는 폭을 통로에 배분 (죽은 공간 최소화)
      // 양 끝 열의 '발쪽'이 벽·통로에 닿으므로 좌우로 발-벽 이격(800mm)을 확보한다
      const FOOT = MEDICAL_RULES.FOOT_WALL_CLEARANCE_CM;
      const availW = fieldX1 - fieldX0 - FOOT * 2;
      let nb = Math.max(0, Math.floor((availW + aisle) / (bandW + aisle)));
      const gaps = Math.max(0, nb - 1);
      const aisleV = gaps > 0
        ? aisle + Math.min(Math.round(aisle * 0.6),
            Math.floor((availW - nb * bandW - gaps * aisle) / gaps / 10) * 10)
        : aisle;
      // 주 동선을 피해 시작 x를 잡는다
      let bx = fieldX0 + FOOT;
      for (let i = 0; i < nb; i++) {
        if (bx + bandW > fieldX1 - FOOT) break;
        const left = fillCol(bx, false);                       // 왼쪽 열: 머리 오른쪽
        const consoleX = bx + MD + 3;
        const right = fillCol(bx + MD + CD + 6, true);         // 오른쪽 열: 머리 왼쪽
        if (left.length || right.length) {
          layConsoleV(consoleX, [...left, ...right]);
          bands.push({ vertical: true, consoleX, above: left, below: right });
        }
        bx += bandW + aisleV;
      }
    }
    let madeBands = 0;
    while (bandAxis === "h" && madeBands < plan.nb && by + MD + CD + MD <= bandY1) {
      // 양면 밴드: 위 행(머리 아래쪽) + 콘솔 + 아래 행(머리 위쪽).
      // 범위는 행마다 따로 계산한다 — 상단 스트립보다 아래에 있는 행은 스트립에
      // 막히지 않고 필드 전폭을 쓰므로 스트립 아래에 죽은 공간이 생기지 않는다.
      const belowY = by + MD + CD + 6;
      const above = fillRow(by, true, boundsFor(by, by + MD));
      const consoleY = by + MD + 3;
      const below = fillRow(belowY, false, boundsFor(belowY, belowY + MD));
      if (above.length || below.length) {
        layConsole(consoleY, [...above, ...below]);
        bands.push({ consoleY, above, below });
      }
      by += bandH + aisleFit;
      madeBands += 1;
    }
    // 계획된 단면(콘솔 위 머리↑) 행 추가 — 남는 높이를 마저 채운다
    if (bandAxis === "h" && (plan.single || plan.nb === 0) && by + CD + MD <= bandY1) {
      const single = fillRow(by + CD + 6, false);
      if (single.length) {
        layConsole(by + 3, single);
        bands.push({ consoleY: by + 3, above: [], below: single });
      }
    }
    // ── 직원 손세정대: 병상 열(밴드)마다 콘솔 끝에 1개 ──
    // 업로드 도면(25BED)에서 손세정대가 각 병상 클러스터 끝단에 놓인 구성을 따른다
    bands.forEach(({ consoleY, consoleX, vertical, above, below }) => {
      const row = (above.length >= below.length ? above : below);
      if (!row.length) return;
      const b = row[row.length - 1];
      if (vertical) { // 세로 콘솔: 열 끝단(아래쪽) 콘솔 옆에 설치
        addEquipment("washbasin", {
          left: Math.round(consoleX - 20), top: Math.round(b.top + b.height + 10), silent: true,
        });
      } else {
        addEquipment("washbasin", {
          left: Math.round(b.left + b.width - 60), top: Math.round(consoleY - 48), silent: true,
        });
      }
    });

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
      // 출입구에서 병상 필드 입구까지만 표시한다 (필드 안은 보조통로가 담당)
      const zoneTop = corridor.y0;
      // 주 동선은 '출입구'에서 시작해 병상 필드 끝까지 이어진다
      const zone = new fabric.Rect({
        left: corridor.x0, top: zoneTop,
        width: corridor.x1 - corridor.x0, height: H - zoneTop,
        fill: "rgba(255,213,79,0.12)", stroke: "#F9A825",
        strokeWidth: 2, strokeDashArray: [18, 12],
        selectable: false, evented: false,
      });
      zone.meta = { key: "annotation", label: "주 동선" };
      canvas.add(zone);
      const cc = (corridor.x0 + corridor.x1) / 2;
      // 출입구 진입 화살표 (입구 → 실내)
      const inArrow = new fabric.Triangle({
        left: cc - 20, top: H - 95, width: 40, height: 52,
        fill: "rgba(249,168,37,0.75)", selectable: false, evented: false,
      });
      inArrow.meta = { key: "annotation" };
      canvas.add(inArrow);
      const inText = new fabric.Text("출입구", {
        left: cc, top: H - 42, fontSize: 24, fill: "#F57F17",
        originX: "center", selectable: false, evented: false,
      });
      inText.meta = { key: "annotation" };
      canvas.add(inText);
      for (let ay = H - 160; ay > zoneTop + 40; ay -= 320) {
        const tri = new fabric.Triangle({
          left: cc - 18, top: ay, width: 36, height: 46,
          fill: "rgba(249,168,37,0.55)", selectable: false, evented: false,
        });
        tri.meta = { key: "annotation" };
        canvas.add(tri);
      }
      const label = new fabric.Text(`주 동선 ${(corridor.x1 - corridor.x0) * 10}`, {
        left: cc, top: zoneTop + 12, fontSize: 26, fill: "#F57F17",
        originX: "center", selectable: false, evented: false,
      });
      label.meta = { key: "annotation" };
      canvas.add(label);
      // 통로 폭 치수선 (양끝 화살표 + mm 표기)
      dimLine("h", corridor.x0, corridor.x1, zoneTop + 40, "#F57F17");
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
        const t = new fabric.Text(`보조 동선 ${aisle * 10}`, {
          left: (sx0 + sx1) / 2, top: yc - 32, fontSize: 20, fill: "#2E7D32",
          originX: "center", selectable: false, evented: false,
        });
        t.meta = { key: "annotation" };
        canvas.add(t);
        // 통로 폭(세로) 치수선 — 좌측 끝에 표기
        dimLine("v", yc - aisle / 2, yc + aisle / 2, sx0 + 60, "#2E7D32");
      };
      // 밴드 사이 통로마다 + 환자 밴드 앞 가로 복도에 표시
      bands.filter((b) => !b.vertical).forEach((b) => {
        const bandBottom = b.consoleY + CD + 3 + MD;
        if (bandBottom + 60 < fieldY1) subPath(Math.min(bandBottom + aisle / 2, fieldY1 - 40));
      });
      // 세로 콘솔 배치: 밴드 사이 '세로' 통로에 보조 동선을 표시한다
      bands.filter((b) => b.vertical).forEach((b, i, arr) => {
        if (i === arr.length - 1) return;
        const xc = Math.round((b.consoleX + CD + MD + arr[i + 1].consoleX - MD) / 2);
        const all = [...b.above, ...b.below];
        if (!all.length) return;
        const y0 = Math.min(...all.map((u) => u.top));
        const y1 = Math.max(...all.map((u) => u.top + u.height));
        const ln = new fabric.Line([xc, y0, xc, y1], {
          stroke: "#2E7D32", strokeWidth: 3, strokeDashArray: [14, 10],
          opacity: 0.8, selectable: false, evented: false,
        });
        ln.meta = { key: "annotation", label: "보조 동선" };
        canvas.add(ln);
        const t = new fabric.Text(`보조 동선 ${aisle * 10}`, {
          left: xc, top: (y0 + y1) / 2, fontSize: 20, fill: "#2E7D32",
          originX: "center", originY: "center", angle: 90,
          selectable: false, evented: false,
        });
        t.meta = { key: "annotation" };
        canvas.add(t);
      });
      subPath(fieldY1 + DOOR_CLEAR / 2); // 환자 밴드 문 앞 복도 (탈의실→병상 동선)
      // 문 앞 복도 치수: 환자 밴드 앞(가로 복도) · 후방 밴드 앞(세로 복도)
      dimLine("v", fieldY1, H - patientBandH - M, sx0 + 200, "#455A64");
      dimLine("h",
        techSide === "left" ? techBandW + M : W - techBandW - M - DOOR_CLEAR,
        techSide === "left" ? techBandW + M + DOOR_CLEAR : W - techBandW - M,
        fieldY1 - 60, "#455A64");
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
      // 세로 콘솔: 콘솔 안을 세로로 주행하고 좌우 병상으로 분기한다
      bands.filter((b) => b.vertical).forEach(({ consoleX, above, below }) => {
        const all = [...above, ...below];
        if (!all.length) return;
        const y0 = Math.min(...all.map((b) => b.top)) - 10;
        const y1 = Math.max(...all.map((b) => b.top + b.height)) + 10;
        const inX = Math.round(consoleX + CD * 0.35), drX = Math.round(consoleX + CD * 0.7);
        // 상단 가로 트렁크에서 콘솔 머리로 인입 후 세로 주행
        addPipe([{ x: trunkX, y: y0 }, { x: inX, y: y0 }, { x: inX, y: y1 }], "inlet");
        addPipe([{ x: trunkX, y: y0 + 14 }, { x: drX, y: y0 + 14 }, { x: drX, y: y1 }], "drain");
        // 투석기는 늘 모듈 오른쪽 끝에 있으므로, 분기는 그 실제 위치로 보낸다.
        // 분기선이 지나는 y는 투석기가 놓인 '병상 사이 틈'이라 침대를 가로지르지 않는다.
        const macOf = (u) => {
          const m = (u.getObjects ? u.getObjects() : [])
            .find((o) => o.meta && o.meta.key === "dialysis_machine");
          if (!m) return null;
          const p = fabric.util.transformPoint(m.getCenterPoint(), u.calcTransformMatrix());
          return { x: p.x, y: Math.round(p.y), w: m.getScaledWidth() };
        };
        above.forEach((b) => { // 왼쪽 열: 콘솔에서 왼쪽 투석기로 분기 (콘솔 바로 옆)
          const m = macOf(b);
          if (m) addPipe([{ x: inX, y: m.y }, { x: Math.round(m.x + m.w / 2), y: m.y }], "inlet");
        });
        below.forEach((b) => { // 오른쪽 열: 투석기가 반대쪽 끝이므로 틈을 따라 건너간다
          const m = macOf(b);
          if (m) addPipe([{ x: inX, y: m.y }, { x: Math.round(m.x - m.w / 2), y: m.y }], "inlet");
        });
      });
      bands.filter((b) => !b.vertical).forEach(({ consoleY, above, below }) => {
        const all = [...above, ...below];
        if (!all.length) return;
        const farX = techSide === "left"
          ? Math.max(...all.map((b) => b.left + b.width))
          : Math.min(...all.map((b) => b.left));
        addPipe([{ x: trunkX, y: inletYOf(consoleY) }, { x: farX, y: inletYOf(consoleY) }], "inlet");
        addPipe([{ x: trunkX, y: drainYOf(consoleY) }, { x: farX, y: drainYOf(consoleY) }], "drain");
        // 위 행(머리 아래쪽): 콘솔에서 위로 분기 / 아래 행(머리 위쪽): 아래로 분기
        // 분기 위치는 모듈 내 장비 존 중앙(투석기 위치)
        const pxOf = (b) => b.left + Math.round((b.width + 120) / 2);
        above.forEach((b) => {
          addPipe([{ x: pxOf(b), y: inletYOf(consoleY) }, { x: pxOf(b), y: b.top + MD - 20 }], "inlet");
        });
        below.forEach((b) => {
          addPipe([{ x: pxOf(b), y: inletYOf(consoleY) }, { x: pxOf(b), y: b.top + 20 }], "inlet");
        });
      });
      // 격리 병상 분기: 첫 밴드 주행선 끝에서 격리실 안까지 연장
      if (isoBedGrp && bands[0] && bands[0].vertical) {
        // 세로 콘솔 구성: 벽체 트렁크에서 격리실 안까지 직접 분기
        const iy = isoBedGrp.top + Math.round(isoBedGrp.height / 2);
        addPipe([{ x: trunkX, y: iy },
                 { x: isoBedGrp.left + Math.round(isoBedGrp.width / 2), y: iy }], "inlet");
      } else if (isoBedGrp && bands[0]) {
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
    applyLayers();  // 동선·치수 주석을 레이어 상태에 맞춰 반영
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    endBulk();
    const totalBeds = getObjects().filter((o) => o.meta.key === "bed_unit").length;
    // ───────── 배치 우선순위 사다리 ─────────
    // ① 장비(병상) 수량 우선 — 실은 제공된 크기 그대로, 병상을 최대로 채운다
    // ② 목표를 채웠고 공간이 남으면 그 여유를 실 크기에 돌려준다 (_inflate)
    // ③ 공간이 모자라면 실 크기를 10%씩(최소 60%) 줄여 병상 자리를 만든다
    // ④ 최소 크기에서도 모자라면 그때 배치된 대수로 확정한다 (장비 수량 감축)
    if (totalBeds < target && shrink > 0.61 && !opts._noShrink) {
      // ③ 실 축소 — 더 줄여도 병상이 늘지 않으면 실이 더 큰 구성으로 되돌린다
      const deeper = autoModel({ ...opts, _variant: vbits, _shrink: Math.round((shrink - 0.1) * 10) / 10 });
      if (deeper.placed > totalBeds) return deeper;
      return autoModel({ ...opts, _variant: vbits, _shrink: shrink, _noShrink: true });
    }
    // ② 목표를 채웠으면 남는 공간을 실에 돌려준다 (병상이 줄면 되돌림)
    if (!inflate && !opts._final && totalBeds >= target) {
      const grown = autoModel({ ...opts, _variant: vbits, _inflate: true, _final: true });
      if (grown.placed >= target) return grown;
      return autoModel({ ...opts, _variant: vbits, _final: true });
    }
    return {
      placed: totalBeds, // 잠긴 병상 포함 전체
      target,
      variant: {
        techSide, aisle, mainCorridor: mainCw, moduleWidth: MW, consoleDepth: CD,
        variant: vbits, // 적용된 골격 조합 (0~15)
        shrink,   // ③단계에서 적용된 실 크기 축소 배율 (1 = 축소 없음)
        inflate,  // ②단계 적용 여부 (목표 달성 후 남는 공간을 실에 환원)
        // 적용된 배치 단계: bed(장비 우선) | grown(여유 환원) | shrunk(실 축소) | capped(대수 감축)
        stage: totalBeds < target ? "capped" : (inflate ? "grown" : (shrink < 1 ? "shrunk" : "bed")),
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

  /**
   * 선택 객체 회전. deg만큼 상대 회전하며(음수 = 반시계), 스냅이 켜져 있으면
   * 15° 단위로 맞춘다. 객체 중심을 기준으로 돌아 제자리에서 방향만 바뀐다.
   * mode "abs"면 deg를 절대 각도로 설정한다.
   */
  function rotateSelection(deg, mode) {
    const o = canvas.getActiveObject();
    if (!o) return false;
    if (o.meta && o.meta.locked) return false; // 잠긴 객체는 회전하지 않는다
    const cur = o.angle || 0;
    let next = mode === "abs" ? deg : cur + deg;
    if (mode !== "abs" && Math.abs(deg) < 90) next = Math.round(next / 15) * 15; // 미세 회전은 15° 스냅
    next = ((next % 360) + 360) % 360;
    // 중심 유지 회전: 원점을 중심으로 옮겨 돌린 뒤 원래 원점으로 복원
    const c = o.getCenterPoint();
    o.set({ angle: next });
    o.setPositionByOrigin(c, "center", "center");
    o.setCoords();
    canvas.requestRenderAll();
    saveHistory();
    return true;
  }

  /** 객체에 잠금 상태를 적용 (이동/회전/크기 잠금 + 표시) */
  function applyLockState(o, lock) {
    o.meta.locked = lock;
    o.set({
      lockMovementX: lock, lockMovementY: lock, lockRotation: lock,
      lockScalingX: lock, lockScalingY: lock,
      hasControls: !lock, opacity: lock ? 0.85 : 1,
    });
  }

  /** 잠금 토글(다중 선택 지원). 잠긴 객체는 Auto Modeling 재배치에서도 고정된다.
   *  반환값 = 잠금 여부(null = 선택 없음) */
  function toggleLockSelection() {
    const objs = canvas.getActiveObjects().filter((o) => o.meta);
    if (!objs.length) return null;
    const lock = !objs[0].meta.locked;
    objs.forEach((o) => applyLockState(o, lock));
    canvas.discardActiveObject();
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

  /* ───────────────── 레이어 (동선 · 치수 · 배관) ─────────────────
   * 동선·치수 표기와 급수/배수 배관은 도면 본체와 분리된 레이어로 관리한다.
   * 표시/숨김 · 편집 잠금 해제(선택·이동·삭제) · 레이어 통째 삭제가 가능하며,
   * 레이어 상태는 JSON 저장에 함께 직렬화된다.
   * 배관은 원래 자유롭게 옮길 수 있었으므로 편집 잠금 없이(locked: false) 시작한다. */
  const LAYERS = {
    flow: { label: "동선 표시", visible: true, locked: true },
    dim: { label: "치수선", visible: true, locked: true },
    pipe_inlet: { label: "급수 배관 (Inlet)", visible: true, locked: false },
    pipe_drain: { label: "배수 배관 (Drain)", visible: true, locked: false },
  };

  /** 객체를 종류·라벨로 레이어에 배정한다 (도면 본체는 레이어 없음) */
  function layerOf(o) {
    if (!o.meta) return null;
    // 급수/배수 배관은 계통별로 나눠 따로 켜고 끌 수 있게 한다
    if (o.meta.key === "pipe") {
      return o.meta.pipeType === "drain" ? "pipe_drain" : "pipe_inlet";
    }
    if (o.meta.key !== "annotation") return null;
    if (o.meta.label === "치수") return "dim";
    if (o.meta.label === "RO 인계점") return "pipe_inlet"; // 배관 시작점 표기
    if (o.meta.label === "벽체 두께 주석") return null;
    return "flow"; // 주 동선·보조 동선·복도 음영·화살표·관찰 시야 등
  }

  /** 객체 하나에 레이어 상태를 반영 (레이어가 없는 객체는 그대로 둔다) */
  function applyLayerTo(o) {
    const key = o.meta && (o.meta.layer ?? layerOf(o));
    if (!key || !LAYERS[key]) return;
    o.meta.layer = key;
    const L = LAYERS[key];
    o.visible = L.visible;
    // 개별 잠금(🔒)은 레이어 설정보다 우선한다 — 잠근 객체가 풀리지 않게 한다
    o.selectable = L.visible && !L.locked && !o.meta.locked;
    o.evented = o.selectable;
    o.setCoords();
  }

  /** 레이어 상태를 캔버스 객체에 반영 */
  function applyLayers() {
    canvas.getObjects().forEach(applyLayerTo);
    canvas.requestRenderAll();
  }

  /** 레이어 표시/잠금 설정 — {visible, locked} 중 지정한 것만 바꾼다 */
  function setLayer(key, opts = {}) {
    const L = LAYERS[key];
    if (!L) return null;
    if (opts.visible !== undefined) L.visible = !!opts.visible;
    if (opts.locked !== undefined) L.locked = !!opts.locked;
    applyLayers();
    saveHistory();
    return { ...L };
  }

  /** 레이어의 모든 객체를 삭제 (되돌리기 가능) */
  function deleteLayer(key) {
    if (!LAYERS[key]) return 0;
    beginBulk();
    const targets = canvas.getObjects().filter((o) => {
      const k = o.meta && (o.meta.layer ?? layerOf(o));
      return k === key;
    });
    targets.forEach((o) => canvas.remove(o));
    canvas.discardActiveObject();
    endBulk();
    canvas.requestRenderAll();
    return targets.length;
  }

  /** 레이어별 상태와 객체 수 */
  function getLayers() {
    const count = {};
    canvas.getObjects().forEach((o) => {
      const k = o.meta && (o.meta.layer ?? layerOf(o));
      if (k) count[k] = (count[k] || 0) + 1;
    });
    return Object.fromEntries(Object.entries(LAYERS)
      .map(([k, v]) => [k, { ...v, count: count[k] || 0 }]));
  }

  function toJSON() {
    return {
      version: 1,
      room,
      // 레이어 표시/편집 상태 — 다른 PC에서 열어도 켜고 끈 그대로 복원된다
      layers: Object.fromEntries(Object.entries(LAYERS)
        .map(([k, v]) => [k, { visible: v.visible, locked: v.locked }])),
      canvas: canvas.toJSON(["meta", "selectable", "evented"]),
    };
  }

  function loadJSON(data, done) {
    beginBulk();
    room = data.room;
    // 저장된 레이어 상태를 먼저 복원한 뒤 객체에 반영한다
    Object.entries(data.layers ?? {}).forEach(([k, v]) => {
      if (!LAYERS[k]) return;
      if (v.visible !== undefined) LAYERS[k].visible = !!v.visible;
      if (v.locked !== undefined) LAYERS[k].locked = !!v.locked;
    });
    canvas.loadFromJSON(data.canvas, () => {
      applyLayers(); // 불러온 도면도 복원된 레이어 상태를 따르게 한다
      endBulk();
      // 잠금 상태 복원 (lockMovement 등은 직렬화되지 않으므로 meta로 재적용)
      canvas.getObjects().forEach((o) => {
        if (o.meta && o.meta.locked) applyLockState(o, true);
      });
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
    init, newRoom, setRoomSize, setBackgroundImage, addEquipment, addPipe, addDoor,
    groupSelection, ungroupSelection, togglePipeMode, finishPipe,
    autoLayout, autoModel, getObjects, deleteSelection, toJSON, loadJSON, exportImage,
    fitToScreen,
    setWallThickness, setConsoleDepth, setModuleWidth, setModuleDepth, setStationSeats, addBedUnit,
    renumberBeds, renameSelected, setBlueprintMode,
    undo, redo, copySelection, pasteClipboard, duplicateSelection,
    distributeSelection, bringSelectionToFront, sendSelectionToBack,
    flipSelection, rotateSelection, toggleLockSelection, zoomBy, exportSVG,
    setLayer, deleteLayer, getLayers, applyLayers,
    // N.S 아일랜드를 임의 위치에 직접 추가 (가구 목록 버튼용)
    addStation: (x, y, seats) => {
      beginBulk();
      const ns = addStationIsland(x, y, seats ?? stationSeats, "left");
      endBulk();
      return ns;
    },
    setSnap: (s) => { snapSize = s; },
    getRoom: () => room,
    getCanvas: () => canvas,
  };
})();
