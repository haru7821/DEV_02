/**
 * app.js — 메인 실행 파일 (UI 초기화 + 이벤트 리스너 등록)
 */
(() => {
  const $ = (id) => document.getElementById(id);

  /**
   * 안전한 이벤트 등록.
   * 요소가 없어도 예외를 던지지 않는다 — HTML/JS 캐시가 어긋나 요소 하나가
   * 사라져도 뒤이어 등록되는 다른 버튼(Auto Modeling 등)이 죽지 않도록 한다.
   */
  function on(id, type, handler) {
    const el = $(id);
    if (!el) { console.warn(`[UI] 요소 없음: #${id} — 리스너를 건너뜁니다.`); return null; }
    el.addEventListener(type, (e) => {
      try {
        handler(e);
      } catch (err) {
        console.error(`[UI] #${id} 처리 중 오류`, err);
        toast(`동작 중 오류가 발생했습니다: ${err.message}`);
      }
    });
    return el;
  }

  /* 단위 변환: 내부 모델은 1px = 1cm, 화면 표기는 모두 mm */
  const toMM = (cm) => Math.round(cm * 10);
  const toCM = (mm) => mm / 10;

  /* ───────── 토스트 알림 ───────── */
  let toastTimer = null;
  function toast(msg, type = "error", ms = 4000) {
    const el = $("toast");
    el.textContent = msg;
    el.className = type;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  /* ───────── 좌측 툴바: 에셋 버튼 / 범례 자동 생성 ───────── */
  const customAssets = {}; // 사용자 정의 시설 (JSON 저장/불러오기 시 함께 직렬화)

  function makeAssetButton(spec, sizeText, onClick) {
    const btn = document.createElement("button");
    btn.className = "asset-btn";
    btn.innerHTML = `<span class="asset-swatch" style="background:${spec.color}"></span>${spec.label}
      <small style="margin-left:auto;color:#90a4ae">${sizeText}</small>`;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function addEquipmentButton(key, spec) {
    const target = spec.category === "wt" ? $("wt-buttons")
      : spec.category === "furn" ? $("furn-buttons")
      : spec.type === "room" ? $("room-buttons") : $("equipment-buttons");
    target.appendChild(makeAssetButton(spec, `${toMM(spec.width)}×${toMM(spec.height)}`,
      () => FloorCanvas.addEquipment(key)));

    const li = document.createElement("li");
    li.innerHTML = `<span class="asset-swatch" style="background:${spec.color}"></span>${spec.label}`;
    $("legend").appendChild(li);
  }

  /* Auto Modeling 시설 체크박스 — 기본값: 전체 선택 (정수실은 필수 고정) */
  function buildFacilityChecks() {
    const wrap = $("facility-checks");
    Object.entries(equipmentData)
      .filter(([k, s]) => s.type === "room" || s.type === "infrastructure")
      .forEach(([k, s]) => {
        const label = document.createElement("label");
        label.className = "fac-check";
        label.innerHTML = `<input type="checkbox" data-key="${k}" checked
          ${k === "water_treatment" ? "disabled" : ""} />
          ${s.label}${k === "water_treatment" ? " (필수)" : ""}`;
        wrap.appendChild(label);
      });
  }

  function buildToolbar() {
    buildFacilityChecks();
    // 병상 모듈(침대+투석기+모니터, 폭 = 모듈 폭 설정값) 원클릭 추가 버튼
    $("equipment-buttons").appendChild(makeAssetButton(
      { label: "병상 모듈 (침대+투석기)", color: "#2E7D32" }, "모듈",
      () => {
        FloorCanvas.setModuleWidth(toCM(+$("module-width").value));
        const r = FloorCanvas.getRoom();
        FloorCanvas.addBedUnit(Math.round(r.width / 2 - 90), Math.round(r.height / 2 - 110), false);
      }));
    Object.entries(equipmentData).forEach(([key, spec]) => addEquipmentButton(key, spec));
    Object.entries(doorData).forEach(([key, spec]) => {
      $("door-buttons").appendChild(makeAssetButton(spec, `폭 ${toMM(spec.width)}`,
        () => FloorCanvas.addDoor(key)));
    });
    // 배관 2계통(급수/배수) 범례 — 색상 견본 포함
    Object.values(pipeTypes).forEach((spec) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="asset-swatch" style="background:${spec.color}"></span>${spec.label}`;
      $("legend").appendChild(li);
    });
  }

  /** 사용자 정의 시설을 카탈로그에 등록하고 툴바 버튼을 생성 */
  function registerCustomAsset(key, spec) {
    if (equipmentData[key]) return;
    equipmentData[key] = spec;
    customAssets[key] = spec;
    addEquipmentButton(key, spec);
  }

  function addCustomAsset() {
    const name = $("custom-name").value.trim();
    const w = toCM(+$("custom-w").value), h = toCM(+$("custom-h").value); // 입력은 mm
    if (!name) return toast("시설 이름을 입력하세요.");
    if (!(w >= 30 && h >= 30)) return toast("시설 크기는 300mm 이상이어야 합니다.");
    const key = "custom_" + Date.now();
    registerCustomAsset(key, {
      label: name, width: w, height: h,
      color: $("custom-color").value, type: "room", custom: true,
    });
    FloorCanvas.addEquipment(key);
    $("custom-name").value = "";
    toast(`「${name}」 시설이 추가되었습니다. 부속실 목록에서 다시 사용할 수 있습니다.`, "info");
  }

  /* ───────── 우측 속성 패널 ───────── */
  function bindPropertyPanel(canvas) {
    const show = (o) => {
      if (!o || !o.meta) { $("prop-form").hidden = true; $("prop-empty").hidden = false; return; }
      $("prop-form").hidden = false;
      $("prop-empty").hidden = true;
      // 병상은 HD 번호(meta.name)를 우선 표시 — 이름 입력으로 번호 수정 가능
      $("prop-name").value = o.meta.name ?? o.meta.label ?? o.meta.key;
      $("prop-x").value = toMM(o.left);
      $("prop-y").value = toMM(o.top);
      $("prop-w").value = toMM(o.getScaledWidth());
      $("prop-h").value = toMM(o.getScaledHeight());
      $("prop-angle").value = Math.round(o.angle);
      $("prop-water").textContent = o.meta.requiresWater ? "예 (RO 배관 필수)" : "아니오";
    };

    canvas.on("selection:created", (e) => show(e.selected?.[0]));
    canvas.on("selection:updated", (e) => show(e.selected?.[0]));
    canvas.on("selection:cleared", () => show(null));
    canvas.on("object:modified", (e) => show(e.target));
    canvas.on("object:moving", (e) => show(e.target));

    const apply = () => {
      const o = canvas.getActiveObject();
      if (!o) return;
      o.set({
        left: toCM(+$("prop-x").value), top: toCM(+$("prop-y").value),
        angle: +$("prop-angle").value,
      });
      const w = toCM(+$("prop-w").value), h = toCM(+$("prop-h").value);
      if (w > 0) o.set("scaleX", w / o.width);
      if (h > 0) o.set("scaleY", h / o.height);
      o.setCoords();
      canvas.requestRenderAll();
    };
    ["prop-x", "prop-y", "prop-w", "prop-h", "prop-angle"].forEach((id) =>
      $(id).addEventListener("change", apply)
    );

    // 이름 변경: 병상은 HD 번호, 그 외는 라벨(그룹 내부 텍스트 포함) 갱신
    $("prop-name").addEventListener("change", () => {
      const name = $("prop-name").value.trim();
      if (name) FloorCanvas.renameSelected(name);
    });
  }

  /* ───────── 검증 실행 + 결과 리포트 ───────── */
  function runValidation() {
    const canvas = FloorCanvas.getCanvas();
    const result = Validator.run(canvas, FloorCanvas.getObjects(), FloorCanvas.getRoom());
    const report = $("validation-report");
    const lines = [];

    lines.push(`병상 수: <b>${result.spacing.bedCount}</b>개`);
    if (result.area) {
      lines.push(result.area.ok
        ? `<span class="ok">✔ 병상당 면적 ${result.area.perBed}m² (권고 ${MEDICAL_RULES.AREA_PER_BED_M2}m² 이상)</span>`
        : `<span class="error">✖ 병상당 면적 ${result.area.perBed}m² &lt; 권고 ${MEDICAL_RULES.AREA_PER_BED_M2}m²</span>`);
    }
    if (result.spacing.violations.length) {
      lines.push(`<span class="error">✖ 병상 간격 위반 ${result.spacing.violations.length}건</span>`);
      lines.push("<ul>" + result.spacing.violations.map((v) =>
        `<li>간격 ${toMM(v.gap)}mm &lt; 기준 ${toMM(MEDICAL_RULES.MIN_BED_GAP_CM)}mm</li>`).join("") + "</ul>");
    } else if (result.spacing.bedCount >= 2) {
      lines.push(`<span class="ok">✔ 모든 병상 간격 ${toMM(MEDICAL_RULES.MIN_BED_GAP_CM)}mm 이상</span>`);
    }

    if (result.foot && result.foot.length) {
      lines.push(`<span class="error">✖ 발쪽-벽 이격(800mm) 위반 ${result.foot.length}건</span>`);
      lines.push("<ul>" + result.foot.map((w) => `<li>${w.msg}</li>`).join("") + "</ul>");
    } else {
      lines.push(`<span class="ok">✔ 발쪽-벽 이격 800mm 이상</span>`);
    }

    if (result.water.length) {
      lines.push(`<span class="error">✖ 배관 동선 경고 ${result.water.length}건</span>`);
      lines.push("<ul>" + result.water.map((w) => `<li>${w.msg}</li>`).join("") + "</ul>");
    } else {
      lines.push(`<span class="ok">✔ 정수 배관 동선 이상 없음</span>`);
    }

    if (result.missing.length) {
      lines.push(`<span class="error">✖ 필수 시설 누락: ${result.missing.join(", ")}</span>`);
    }

    report.innerHTML = lines.join("<br>");

    if (result.pass) {
      toast("✔ 모든 의료 규격 검증을 통과했습니다.", "info");
    } else {
      const total = result.spacing.violations.length + result.water.length + result.missing.length;
      toast(`⚠ 규격 위반 ${total}건이 발견되었습니다.\n위반 객체가 빨간색으로 깜빡입니다. 우측 패널에서 상세 내용을 확인하세요.`);
    }
  }

  /* ───────── PDF 가로모드 출력 ───────── */
  function exportPDF() {
    const { jsPDF } = window.jspdf;
    const room = FloorCanvas.getRoom();
    const img = FloorCanvas.exportImage();

    const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();   // 297
    const pageH = pdf.internal.pageSize.getHeight();  // 210
    const margin = 12, headH = 14;

    // 표제란
    pdf.setFontSize(14);
    pdf.text("Hemodialysis Unit Floor Plan", margin, margin);
    pdf.setFontSize(9);
    pdf.text(`Room: ${toMM(room.width).toLocaleString()} x ${toMM(room.height).toLocaleString()} mm   Scale: fit-to-page   Date: ${new Date().toISOString().slice(0, 10)}`,
      margin, margin + 6);
    pdf.setLineWidth(0.4);
    pdf.line(margin, margin + 9, pageW - margin, margin + 9);

    // 도면 이미지 (비율 유지, 페이지에 맞춤)
    const availW = pageW - margin * 2;
    const availH = pageH - margin * 2 - headH;
    const ratio = room.width / room.height;
    let w = availW, h = w / ratio;
    if (h > availH) { h = availH; w = h * ratio; }
    pdf.addImage(img, "JPEG", margin + (availW - w) / 2, margin + headH + (availH - h) / 2, w, h);

    pdf.save("dialysis-room-floorplan.pdf");
    toast("PDF(가로모드) 파일이 다운로드되었습니다.", "info");
  }

  /* ───────── JSON 저장 / 열기 ───────── */
  function saveJSON() {
    const data = FloorCanvas.toJSON();
    data.customAssets = customAssets; // 사용자 정의 시설 사양도 함께 저장
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dialysis-room-plan.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function loadJSONFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        Object.entries(data.customAssets ?? {}).forEach(([k, s]) => registerCustomAsset(k, s));
        FloorCanvas.loadJSON(data, () => toast("도면을 불러왔습니다.", "info"));
      } catch (e) {
        toast("JSON 파일을 읽을 수 없습니다: " + e.message);
      }
    };
    reader.readAsText(file);
  }

  /* ───────── 도면 사진 배경 불러오기 ───────── */
  function loadImageFile(file) {
    const realW = prompt("도면 사진의 실제 가로 길이를 mm로 입력하세요.\n(예: 15m → 15000)", "15000");
    if (!realW || isNaN(+realW)) return;
    const reader = new FileReader();
    reader.onload = () => {
      FloorCanvas.setBackgroundImage(reader.result, toCM(+realW));
      toast("도면 사진을 배경으로 설정했습니다. 사진 위에 장비를 배치하세요.", "info");
    };
    reader.readAsDataURL(file);
  }

  /* ───────── 초기화 ───────── */
  document.addEventListener("DOMContentLoaded", () => {
    FloorCanvas.init("floor-canvas");
    buildToolbar();
    bindPropertyPanel(FloorCanvas.getCanvas());

    // 상단 네비게이션
    on("btn-new-room", "click", () => {
      const w = toCM(+$("room-width").value), h = toCM(+$("room-height").value); // 입력은 mm
      if (w < 300 || h < 300) return toast("병실 크기는 최소 3,000mm × 3,000mm 이상이어야 합니다.");
      FloorCanvas.setWallThickness(toCM(+$("wall-thickness").value));
      FloorCanvas.setConsoleDepth(toCM(+$("console-depth").value));
      FloorCanvas.newRoom(w, h);
      $("validation-report").textContent = "아직 검증하지 않았습니다.";
    });
    // 콘솔 두께 입력: 이후 추가/자동 배치되는 배관 콘솔부터 즉시 적용
    on("console-depth", "change", (e) =>
      FloorCanvas.setConsoleDepth(toCM(+e.target.value)));
    on("btn-load-image", "click", () => $("image-file-input").click());
    on("image-file-input", "change", (e) => {
      if (e.target.files[0]) loadImageFile(e.target.files[0]);
      e.target.value = "";
    });
    on("snap-size", "change", (e) => FloorCanvas.setSnap(+e.target.value));
    // Auto Modeling: 선택 시설 + 목표 병상 대수로 매번 다른 랜덤 구성 생성
    on("btn-auto-model", "click", () => {
      FloorCanvas.setWallThickness(toCM(+$("wall-thickness").value));
      FloorCanvas.setConsoleDepth(toCM(+$("console-depth").value));
      if (!FloorCanvas.getCanvas().backgroundImage) {
        const w = toCM(+$("room-width").value), h = toCM(+$("room-height").value);
        if (w < 300 || h < 300) return toast("병실 크기는 최소 3,000mm × 3,000mm 이상이어야 합니다.");
        FloorCanvas.newRoom(w, h);
      }
      const facilities = [...new Set(["water_treatment",
        ...[...document.querySelectorAll("#facility-checks input:checked")].map((el) => el.dataset.key)])];
      FloorCanvas.setModuleWidth(toCM(+$("module-width").value));
      FloorCanvas.setStationSeats(+$("station-seats").value);
      const r = FloorCanvas.autoModel({
        targetBeds: +$("target-beds").value,
        facilities,
        passage: toCM(+$("passage-width").value), // 마주보는 장비 사이 통로 폭
        seed: (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0, // 누를 때마다 다른 시드
      });
      $("validation-report").textContent = "아직 검증하지 않았습니다.";
      toast(r.placed >= r.target
        ? `Auto Modeling 완료: 병상 ${r.placed}대 배치 (서비스 존 ${r.variant.techSide === "left" ? "좌측" : "우측"}, 통로 ${r.variant.aisle * 10}mm).\n버튼을 다시 누르면 다른 구성이 생성됩니다.`
        : `공간 제약으로 요청 ${r.target}대 중 ${r.placed}대만 배치했습니다.\n병실 크기를 늘리거나 시설 수를 줄여보세요. (다시 누르면 다른 구성 시도)`,
        r.placed >= r.target ? "info" : "error", 6000);
    });

    on("btn-validate", "click", runValidation);
    on("btn-save-json", "click", saveJSON);
    on("btn-load-json", "click", () => $("json-file-input").click());
    on("json-file-input", "change", (e) => {
      if (e.target.files[0]) loadJSONFile(e.target.files[0]);
      e.target.value = "";
    });
    on("btn-export-pdf", "click", exportPDF);

    // 흑백 도면(청사진) 모드 토글
    let blueprintOn = false;
    on("btn-blueprint", "click", (e) => {
      blueprintOn = FloorCanvas.setBlueprintMode(!blueprintOn);
      e.target.classList.toggle("active", blueprintOn);
      toast(blueprintOn ? "도면 모드: 흑백 건축 도면 스타일로 표시합니다. (배관 색상은 유지)"
                        : "도면 모드를 해제하고 원래 색상으로 복원했습니다.", "info");
    });

    // 좌측 도구
    on("btn-group", "click", () =>
      FloorCanvas.groupSelection() || toast("먼저 Shift 클릭으로 두 개 이상 객체를 선택하세요."));
    on("btn-ungroup", "click", () =>
      FloorCanvas.ungroupSelection() || toast("해제할 그룹을 선택하세요."));

    // 배관 그리기 버튼 (급수/배수) — 켜진 버튼만 종료 안내 문구로 전환
    const PIPE_BUTTONS = {
      "btn-add-pipe-inlet": { type: "inlet", label: "급수 배관 (Inlet)" },
      "btn-add-pipe-drain": { type: "drain", label: "배수 배관 (Drain)" },
    };
    const resetPipeButtons = () =>
      Object.entries(PIPE_BUTTONS).forEach(([id, b]) => { $(id).textContent = b.label; });
    Object.entries(PIPE_BUTTONS).forEach(([id, b]) => {
      $(id).addEventListener("click", () => {
        const on = FloorCanvas.togglePipeMode(b.type);
        resetPipeButtons();
        if (on) {
          $(id).textContent = "배관 그리기 종료 (더블클릭)";
          toast(`캔버스를 클릭해 ${b.label} 경로를 찍고, 더블클릭으로 완료하세요.`, "info");
        }
      });
    });

    on("btn-renumber", "click", () => {
      const n = FloorCanvas.renumberBeds();
      if (!n) return toast("재정렬할 병상이 없습니다.");
      toast(`병상 ${n}개의 번호를 HD1부터 다시 부여했습니다.`, "info");
    });
    on("btn-delete", "click", FloorCanvas.deleteSelection);
    on("btn-add-custom", "click", addCustomAsset);

    // PNG / SVG 내보내기
    const downloadBlob = (blob, filename) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    on("btn-export-png", "click", () => {
      const url = FloorCanvas.exportImage("png");
      const a = document.createElement("a");
      a.href = url;
      a.download = "dialysis-room-floorplan.png";
      a.click();
      toast("PNG 이미지가 다운로드되었습니다.", "info");
    });
    on("btn-export-svg", "click", () => {
      downloadBlob(new Blob([FloorCanvas.exportSVG()], { type: "image/svg+xml" }),
        "dialysis-room-floorplan.svg");
      toast("SVG 벡터 파일이 다운로드되었습니다.", "info");
    });

    // 편집 도구 (실행취소·복제·반전·순서·잠금)
    on("btn-undo", "click", () =>
      FloorCanvas.undo() || toast("더 이상 취소할 작업이 없습니다."));
    on("btn-redo", "click", () =>
      FloorCanvas.redo() || toast("다시 실행할 작업이 없습니다."));
    on("btn-duplicate", "click", () =>
      FloorCanvas.duplicateSelection() || toast("복제할 객체를 먼저 선택하세요."));
    on("btn-flip-h", "click", () =>
      FloorCanvas.flipSelection("h") || toast("반전할 객체를 먼저 선택하세요."));
    on("btn-flip-v", "click", () =>
      FloorCanvas.flipSelection("v") || toast("반전할 객체를 먼저 선택하세요."));
    on("btn-front", "click", () =>
      FloorCanvas.bringSelectionToFront() || toast("객체를 먼저 선택하세요."));
    on("btn-back", "click", () =>
      FloorCanvas.sendSelectionToBack() || toast("객체를 먼저 선택하세요."));
    on("btn-lock", "click", () => {
      const locked = FloorCanvas.toggleLockSelection();
      if (locked === null) return toast("잠글 객체를 먼저 선택하세요.");
      toast(locked ? "선택 객체를 잠갔습니다. (이동/크기/회전 불가)" : "잠금을 해제했습니다.", "info");
    });

    // 정렬 / 등간격 배치
    const ALIGN_BUTTONS = {
      "btn-align-left": "left", "btn-align-hcenter": "hcenter", "btn-align-right": "right",
      "btn-align-top": "top", "btn-align-vcenter": "vcenter", "btn-align-bottom": "bottom",
    };
    Object.entries(ALIGN_BUTTONS).forEach(([id, mode]) => {
      $(id).addEventListener("click", () =>
        FloorCanvas.alignSelection(mode) || toast("Shift 클릭으로 두 개 이상 객체를 선택하세요."));
    });
    on("btn-dist-h", "click", () =>
      FloorCanvas.distributeSelection("h") || toast("세 개 이상 객체를 선택하세요."));
    on("btn-dist-v", "click", () =>
      FloorCanvas.distributeSelection("v") || toast("세 개 이상 객체를 선택하세요."));

    // 줌 컨트롤
    const updateZoomLabel = () => {
      $("zoom-label").textContent = Math.round(FloorCanvas.getCanvas().getZoom() * 100) + "%";
    };
    on("btn-zoom-in", "click", () => { FloorCanvas.zoomBy(1.2); });
    on("btn-zoom-out", "click", () => { FloorCanvas.zoomBy(1 / 1.2); });
    on("btn-zoom-fit", "click", () => { FloorCanvas.fitToScreen(); });
    FloorCanvas.getCanvas().on("after:render", updateZoomLabel);
    updateZoomLabel();

    // 키보드
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT") return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); FloorCanvas.undo(); return; }
      if (ctrl && e.key.toLowerCase() === "y") { e.preventDefault(); FloorCanvas.redo(); return; }
      if (ctrl && e.key.toLowerCase() === "c") { e.preventDefault(); FloorCanvas.copySelection(); return; }
      if (ctrl && e.key.toLowerCase() === "v") { e.preventDefault(); FloorCanvas.pasteClipboard(); return; }
      if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); FloorCanvas.duplicateSelection(); return; }
      if (e.key === "Delete" || e.key === "Backspace") FloorCanvas.deleteSelection();
      if (e.key === "Escape") {
        FloorCanvas.finishPipe();
        resetPipeButtons();
      }
    });
  });
})();
