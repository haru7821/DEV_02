/**
 * app.js — 메인 실행 파일 (UI 초기화 + 이벤트 리스너 등록)
 */
(() => {
  const $ = (id) => document.getElementById(id);

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
    const target = spec.type === "room" ? $("room-buttons") : $("equipment-buttons");
    target.appendChild(makeAssetButton(spec, `${spec.width}×${spec.height}`,
      () => FloorCanvas.addEquipment(key)));

    const li = document.createElement("li");
    li.innerHTML = `<span class="asset-swatch" style="background:${spec.color}"></span>${spec.label}`;
    $("legend").appendChild(li);
  }

  function buildToolbar() {
    Object.entries(equipmentData).forEach(([key, spec]) => addEquipmentButton(key, spec));
    Object.entries(doorData).forEach(([key, spec]) => {
      $("door-buttons").appendChild(makeAssetButton(spec, `폭 ${spec.width}`,
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
    const w = +$("custom-w").value, h = +$("custom-h").value;
    if (!name) return toast("시설 이름을 입력하세요.");
    if (!(w >= 30 && h >= 30)) return toast("시설 크기는 30cm 이상이어야 합니다.");
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
      $("prop-x").value = Math.round(o.left);
      $("prop-y").value = Math.round(o.top);
      $("prop-w").value = Math.round(o.getScaledWidth());
      $("prop-h").value = Math.round(o.getScaledHeight());
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
      o.set({ left: +$("prop-x").value, top: +$("prop-y").value, angle: +$("prop-angle").value });
      const w = +$("prop-w").value, h = +$("prop-h").value;
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
        `<li>간격 ${v.gap}cm &lt; 기준 ${MEDICAL_RULES.MIN_BED_GAP_CM}cm</li>`).join("") + "</ul>");
    } else if (result.spacing.bedCount >= 2) {
      lines.push(`<span class="ok">✔ 모든 병상 간격 ${MEDICAL_RULES.MIN_BED_GAP_CM}cm 이상</span>`);
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
    pdf.text(`Room: ${room.width / 100}m x ${room.height / 100}m   Scale: fit-to-page   Date: ${new Date().toISOString().slice(0, 10)}`,
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
    const realW = prompt("도면 사진의 실제 가로 길이를 cm로 입력하세요.\n(예: 15m → 1500)", "1500");
    if (!realW || isNaN(+realW)) return;
    const reader = new FileReader();
    reader.onload = () => {
      FloorCanvas.setBackgroundImage(reader.result, +realW);
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
    $("btn-new-room").addEventListener("click", () => {
      const w = +$("room-width").value, h = +$("room-height").value;
      if (w < 300 || h < 300) return toast("병실 크기는 최소 3m × 3m 이상이어야 합니다.");
      FloorCanvas.setWallThickness(+$("wall-thickness").value);
      FloorCanvas.newRoom(w, h);
      $("validation-report").textContent = "아직 검증하지 않았습니다.";
    });
    $("btn-load-image").addEventListener("click", () => $("image-file-input").click());
    $("image-file-input").addEventListener("change", (e) => {
      if (e.target.files[0]) loadImageFile(e.target.files[0]);
      e.target.value = "";
    });
    $("snap-size").addEventListener("change", (e) => FloorCanvas.setSnap(+e.target.value));
    $("btn-auto-layout").addEventListener("click", () => {
      FloorCanvas.setWallThickness(+$("wall-thickness").value);
      // 배경 도면 사진이 있으면 사진 크기를 유지, 없으면 입력값으로 새 도면 생성
      if (!FloorCanvas.getCanvas().backgroundImage) {
        const w = +$("room-width").value, h = +$("room-height").value;
        if (w < 300 || h < 300) return toast("병실 크기는 최소 3m × 3m 이상이어야 합니다.");
        FloorCanvas.newRoom(w, h);
      }
      const { beds } = FloorCanvas.autoLayout();
      toast(`자동 배치 완료: 병상 ${beds}개 + 부속실 + 급수/배수 배관.\n'검증' 버튼으로 규격을 확인하세요.`, "info", 5000);
    });
    $("btn-validate").addEventListener("click", runValidation);
    $("btn-save-json").addEventListener("click", saveJSON);
    $("btn-load-json").addEventListener("click", () => $("json-file-input").click());
    $("json-file-input").addEventListener("change", (e) => {
      if (e.target.files[0]) loadJSONFile(e.target.files[0]);
      e.target.value = "";
    });
    $("btn-export-pdf").addEventListener("click", exportPDF);

    // 흑백 도면(청사진) 모드 토글
    let blueprintOn = false;
    $("btn-blueprint").addEventListener("click", (e) => {
      blueprintOn = FloorCanvas.setBlueprintMode(!blueprintOn);
      e.target.classList.toggle("active", blueprintOn);
      toast(blueprintOn ? "도면 모드: 흑백 건축 도면 스타일로 표시합니다. (배관 색상은 유지)"
                        : "도면 모드를 해제하고 원래 색상으로 복원했습니다.", "info");
    });

    // 좌측 도구
    $("btn-group").addEventListener("click", () =>
      FloorCanvas.groupSelection() || toast("먼저 Shift 클릭으로 두 개 이상 객체를 선택하세요."));
    $("btn-ungroup").addEventListener("click", () =>
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

    $("btn-renumber").addEventListener("click", () => {
      const n = FloorCanvas.renumberBeds();
      if (!n) return toast("재정렬할 병상이 없습니다.");
      toast(`병상 ${n}개의 번호를 HD1부터 다시 부여했습니다.`, "info");
    });
    $("btn-delete").addEventListener("click", FloorCanvas.deleteSelection);
    $("btn-add-custom").addEventListener("click", addCustomAsset);

    // PNG / SVG 내보내기
    const downloadBlob = (blob, filename) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    $("btn-export-png").addEventListener("click", () => {
      const url = FloorCanvas.exportImage("png");
      const a = document.createElement("a");
      a.href = url;
      a.download = "dialysis-room-floorplan.png";
      a.click();
      toast("PNG 이미지가 다운로드되었습니다.", "info");
    });
    $("btn-export-svg").addEventListener("click", () => {
      downloadBlob(new Blob([FloorCanvas.exportSVG()], { type: "image/svg+xml" }),
        "dialysis-room-floorplan.svg");
      toast("SVG 벡터 파일이 다운로드되었습니다.", "info");
    });

    // 편집 도구 (실행취소·복제·반전·순서·잠금)
    $("btn-undo").addEventListener("click", () =>
      FloorCanvas.undo() || toast("더 이상 취소할 작업이 없습니다."));
    $("btn-redo").addEventListener("click", () =>
      FloorCanvas.redo() || toast("다시 실행할 작업이 없습니다."));
    $("btn-duplicate").addEventListener("click", () =>
      FloorCanvas.duplicateSelection() || toast("복제할 객체를 먼저 선택하세요."));
    $("btn-flip-h").addEventListener("click", () =>
      FloorCanvas.flipSelection("h") || toast("반전할 객체를 먼저 선택하세요."));
    $("btn-flip-v").addEventListener("click", () =>
      FloorCanvas.flipSelection("v") || toast("반전할 객체를 먼저 선택하세요."));
    $("btn-front").addEventListener("click", () =>
      FloorCanvas.bringSelectionToFront() || toast("객체를 먼저 선택하세요."));
    $("btn-back").addEventListener("click", () =>
      FloorCanvas.sendSelectionToBack() || toast("객체를 먼저 선택하세요."));
    $("btn-lock").addEventListener("click", () => {
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
    $("btn-dist-h").addEventListener("click", () =>
      FloorCanvas.distributeSelection("h") || toast("세 개 이상 객체를 선택하세요."));
    $("btn-dist-v").addEventListener("click", () =>
      FloorCanvas.distributeSelection("v") || toast("세 개 이상 객체를 선택하세요."));

    // 줌 컨트롤
    const updateZoomLabel = () => {
      $("zoom-label").textContent = Math.round(FloorCanvas.getCanvas().getZoom() * 100) + "%";
    };
    $("btn-zoom-in").addEventListener("click", () => { FloorCanvas.zoomBy(1.2); });
    $("btn-zoom-out").addEventListener("click", () => { FloorCanvas.zoomBy(1 / 1.2); });
    $("btn-zoom-fit").addEventListener("click", () => { FloorCanvas.fitToScreen(); });
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
