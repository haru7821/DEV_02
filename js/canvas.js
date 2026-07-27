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
  let pipePoints = [];        // 그리는 중인 배관 꼭짓점
  let pipePreview = null;     // 미리보기 라인

  const GRID_STEP = 50;       // 화면에 그리는 그리드 간격(cm)
  const WALL = 10;            // 벽 두께(cm)

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
    room = { width: w, height: h };
    canvas.clear();
    canvas.backgroundColor = "#ffffff";
    drawGrid();
    drawWalls();
    fitToScreen();
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
    const grp = new fabric.Group([rect, text], {
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
    if (!opts.silent) { canvas.setActiveObject(grp); canvas.requestRenderAll(); }
    return grp;
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

  /* ───────────────── 정수 배관 그리기 ───────────────── */
  function togglePipeMode() {
    pipeMode = !pipeMode;
    if (!pipeMode) finishPipe();
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
    pipePreview = new fabric.Polyline([...pipePoints, cursor], {
      fill: "", stroke: "#9C27B0", strokeWidth: 6, strokeDashArray: [15, 10],
      selectable: false, evented: false,
    });
    canvas.add(pipePreview);
    canvas.requestRenderAll();
  }

  function finishPipe() {
    if (pipePreview) { canvas.remove(pipePreview); pipePreview = null; }
    if (pipePoints.length >= 2) addPipe(pipePoints);
    pipePoints = [];
    pipeMode = false;
    canvas.defaultCursor = "default";
  }

  function addPipe(points) {
    const pipe = new fabric.Polyline(points, {
      fill: "", stroke: "#9C27B0", strokeWidth: 6, strokeDashArray: [15, 10],
    });
    pipe.meta = { key: "pipe", label: "정수 배관" };
    canvas.add(pipe);
    return pipe;
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
    if (!opts.silent) { canvas.setActiveObject(grp); canvas.requestRenderAll(); }
    return grp;
  }

  /* ───────────────── 자동 배치 ─────────────────
   * 입력된 병실 크기에 맞춰 정수실·창고·탈의실·화장실·간호사실·격리실을
   * 벽면에 배치하고, 남은 면적에 병상 유닛(침대+투석기)을 규격 간격으로
   * 채운 뒤 정수 배관 동선을 그린다. */
  function autoLayout() {
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
    return { beds: topBeds.length + bottomBeds.length };
  }

  function fillBedRow(x0, x1, y, pitch) {
    const beds = [];
    for (let x = x0; x + equipmentData.dialysis_bed.width + 60 <= x1; x += pitch) {
      beds.push(addBedUnit(x, y, false));
    }
    return beds;
  }

  /** 침대 + 투석기 + 모니터를 하나의 유닛 그룹으로 생성 */
  function addBedUnit(x, y, isolated) {
    const bed = addEquipment("dialysis_bed", { left: x, top: y, silent: true });
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
    canvas.requestRenderAll();
    return grp;
  }

  function drawPipeRuns(topBeds, bottomBeds, bottomRowY) {
    const wt = getObjects().find((o) => o.meta.key === "water_treatment");
    if (!wt || !topBeds.length) return;
    const runY = 20; // 상단 벽을 따라 주행하는 메인 배관 높이
    const startX = wt.left + wt.width;
    const endX = topBeds[topBeds.length - 1].left + topBeds[topBeds.length - 1].width;
    addPipe([{ x: startX, y: wt.top + 100 }, { x: startX + 20, y: wt.top + 100 },
             { x: startX + 20, y: runY }, { x: endX, y: runY }]);
    topBeds.forEach((b) => {
      const px = b.left + b.width - 30;
      addPipe([{ x: px, y: runY }, { x: px, y: b.top + 20 }]);
    });
    if (bottomBeds.length) {
      const dropX = startX + 20;
      const runY2 = bottomRowY - 20;
      const endX2 = bottomBeds[bottomBeds.length - 1].left + bottomBeds[bottomBeds.length - 1].width;
      addPipe([{ x: dropX, y: runY }, { x: dropX, y: runY2 }, { x: endX2, y: runY2 }]);
      bottomBeds.forEach((b) => {
        const px = b.left + b.width - 30;
        addPipe([{ x: px, y: runY2 }, { x: px, y: b.top + 20 }]);
      });
    }
  }

  /* ───────────────── 조회/직렬화 유틸 ───────────────── */
  /** 그리드·벽을 제외한 배치 객체 목록 */
  function getObjects() {
    return canvas.getObjects().filter((o) => o.meta && !["grid", "wall"].includes(o.meta.key));
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
    room = data.room;
    canvas.loadFromJSON(data.canvas, () => {
      fitToScreen();
      canvas.requestRenderAll();
      if (done) done();
    });
  }

  /** PDF 출력용: 도면 전체 영역을 고해상도 PNG로 렌더링 */
  function exportImage() {
    const saved = canvas.viewportTransform.slice();
    fitToScreen();
    canvas.discardActiveObject();
    canvas.renderAll();
    // JPEG 사용: PNG 대비 PDF 용량을 크게 줄임 (배경이 흰색이라 품질 손실 없음)
    const url = canvas.toDataURL({ format: "jpeg", quality: 0.9, multiplier: 2 });
    canvas.setViewportTransform(saved);
    canvas.requestRenderAll();
    return url;
  }

  return {
    init, newRoom, setBackgroundImage, addEquipment, addPipe, addDoor,
    groupSelection, ungroupSelection, togglePipeMode, finishPipe,
    autoLayout, getObjects, deleteSelection, toJSON, loadJSON, exportImage,
    fitToScreen,
    setSnap: (s) => { snapSize = s; },
    getRoom: () => room,
    getCanvas: () => canvas,
  };
})();
