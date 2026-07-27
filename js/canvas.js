/**
 * canvas.js — Fabric.js 캔버스 제어 (배치·이동·회전·스냅·그룹화·자동배치)
 *
 * 좌표계: 1px = 1cm. 화면 배율은 fabric의 zoom으로만 조절하므로
 * 모든 객체의 left/top/width/height 값이 곧 실제 cm 치수다.
 */
const FloorCanvas = (() => {
  let canvas = null;          // fabric.Canvas
  let room = { width: 1500, height: 1000 }; // 병실 내부 치수(cm)
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

  /** 벽 두께 설정(cm). 다음 새 도면/자동 배치부터 적용된다. */
  function setWallThickness(t) {
    WALL = Math.min(40, Math.max(5, Math.round(+t) || 10));
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

    // ── 그리드 스냅: 이동 중 left/top을 snapSize 단위로 반올림 ──
    canvas.on("object:moving", (e) => {
      if (!snapSize) return;
      const o = e.target;
      o.set({
        left: Math.round(o.left / snapSize) * snapSize,
        top: Math.round(o.top / snapSize) * snapSize,
      });
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
    const spec = equipmentData[key];
    if (!spec) return null;

    const rect = new fabric.Rect({
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

    // ⑦ 출입문 자동 배치
    addDoor("auto_door", { left: nurseX - 220, top: H - 4, silent: true });     // 주 출입구 자동문
    addDoor("swing_door", { left: 40, top: H - 264, silent: true });            // 탈의실 문
    addDoor("swing_door", { left: 240, top: H - 214, silent: true });           // 화장실 문
    addDoor("swing_door", { left: 322, top: 60, angle: 90, silent: true });     // 정수실 문 (오른쪽 벽, 세로)
    addDoor("swing_door", { left: 232, top: 470, angle: 90, silent: true });    // 창고 문 (오른쪽 벽)
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

  /** 침대 + 투석기 + 모니터를 하나의 유닛 그룹으로 생성 (HD 번호 자동 부여) */
  function addBedUnit(x, y, isolated) {
    // 침대는 유닛 내부이므로 inUnit으로 단독 HD 번호 부여를 건너뛰고, 유닛에 번호를 준다
    const bed = addEquipment("dialysis_bed", { left: x, top: y, silent: true, inUnit: true });
    const machine = addEquipment("dialysis_machine", { left: x + 125, top: y, silent: true });
    const monitor = addEquipment("patient_monitor", { left: x + 125, top: y + 80, silent: true });
    const sel = new fabric.ActiveSelection([bed, machine, monitor], { canvas });
    const grp = sel.toGroup();
    grp.meta = {
      key: "bed_unit",
      label: isolated ? "격리 병상 유닛" : "병상 유닛",
      requiresWater: true,
      isolationCapable: true,
      isolated,
      members: ["dialysis_bed", "dialysis_machine", "patient_monitor"],
    };
    assignBedNumber(grp);
    canvas.requestRenderAll();
    return grp;
  }

  function drawPipeRuns(topBeds, bottomBeds, bottomRowY) {
    const wt = getObjects().find((o) => o.meta.key === "water_treatment");
    if (!wt || !topBeds.length) return;
    const DRAIN_OFF = 14; // 급수 주행선에서 y로 평행 이동한 배수 주행선 간격(cm)
    const drainOf = (pts) => pts.map((p) => ({ x: p.x, y: p.y + DRAIN_OFF })); // 배수 평행선 좌표
    const runY = 20; // 상단 벽을 따라 주행하는 메인 배관 높이
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
      const dropX = startX + 20;
      const runY2 = bottomRowY - 20;
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

  /** mode: left | hcenter | right | top | vcenter | bottom */
  function alignSelection(mode) {
    return withSelection(2, (items) => {
      const L = Math.min(...items.map((i) => i.r.left));
      const R = Math.max(...items.map((i) => i.r.left + i.r.width));
      const T = Math.min(...items.map((i) => i.r.top));
      const B = Math.max(...items.map((i) => i.r.top + i.r.height));
      items.forEach(({ o, r }) => {
        if (mode === "left") o.set("left", o.left + (L - r.left));
        else if (mode === "right") o.set("left", o.left + (R - r.width - r.left));
        else if (mode === "hcenter") o.set("left", o.left + ((L + R - r.width) / 2 - r.left));
        else if (mode === "top") o.set("top", o.top + (T - r.top));
        else if (mode === "bottom") o.set("top", o.top + (B - r.height - r.top));
        else if (mode === "vcenter") o.set("top", o.top + ((T + B - r.height) / 2 - r.top));
      });
    });
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
    autoLayout, getObjects, deleteSelection, toJSON, loadJSON, exportImage,
    fitToScreen,
    setWallThickness, renumberBeds, renameSelected, setBlueprintMode,
    undo, redo, copySelection, pasteClipboard, duplicateSelection,
    alignSelection, distributeSelection, bringSelectionToFront, sendSelectionToBack,
    flipSelection, toggleLockSelection, zoomBy, exportSVG,
    setSnap: (s) => { snapSize = s; },
    getRoom: () => room,
    getCanvas: () => canvas,
  };
})();
