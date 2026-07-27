/**
 * validation.js — 의료 규격 자동 검증
 *
 * ① 병상 이격 거리: 모든 병상(침대/병상 유닛) 쌍의 "테두리 간 최단 거리"를
 *    Math.hypot()으로 계산해 기준(1m) 미만이면 빨간 테두리로 깜빡이며 경고.
 * ② 정수 배관 동선: requiresWater 장비가 정수실에서 너무 멀거나(MAX_PIPE_RUN)
 *    근처에 배관이 전혀 없으면(시각적 단절) 경고.
 * ③ 필수 시설 존재 여부: 정수실·간호사실 미배치 경고.
 */
const Validator = (() => {
  let blinkTimer = null;
  let blinkTargets = [];

  /** 회전을 반영한 축 정렬 바운딩 박스(cm) */
  function bbox(o) {
    const r = o.getBoundingRect(true, true);
    return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height,
             cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }

  /**
   * 두 사각형 테두리 사이의 최단 거리(cm).
   * 축별 간격(dx, dy)을 구한 뒤 피타고라스 정리(Math.hypot)로 합성한다.
   * 겹치면 0.
   */
  function rectGap(a, b) {
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return Math.hypot(dx, dy);
  }

  function isBed(o) {
    return o.meta && (o.meta.key === "dialysis_bed" || o.meta.key === "bed_unit");
  }

  /* ───────── ① 병상 이격 거리 검증 ───────── */
  function checkBedSpacing(objects) {
    const beds = objects.filter(isBed);
    const violations = [];
    for (let i = 0; i < beds.length; i++) {
      for (let j = i + 1; j < beds.length; j++) {
        const gap = rectGap(bbox(beds[i]), bbox(beds[j]));
        if (gap < MEDICAL_RULES.MIN_BED_GAP_CM) {
          violations.push({ a: beds[i], b: beds[j], gap: Math.round(gap) });
        }
      }
    }
    return { bedCount: beds.length, violations };
  }

  /* ───────── ② 정수 배관 동선 검증 ───────── */
  function checkWaterRuns(objects) {
    const wt = objects.find((o) => o.meta.key === "water_treatment");
    const pipes = objects.filter((o) => o.meta.key === "pipe");
    const waterEquip = objects.filter((o) => o.meta.requiresWater);
    const warnings = [];

    if (!wt) {
      if (waterEquip.length) warnings.push({ msg: "정수실(Water Treatment)이 배치되지 않았습니다.", targets: waterEquip });
      return warnings;
    }

    const wtBox = bbox(wt);
    waterEquip.forEach((eq) => {
      const eqBox = bbox(eq);
      // 거리 초과: 정수실과의 직선 동선이 기준을 넘는 경우
      const dist = Math.hypot(eqBox.cx - wtBox.cx, eqBox.cy - wtBox.cy);
      if (dist > MEDICAL_RULES.MAX_PIPE_RUN_CM) {
        warnings.push({ msg: `「${eq.meta.label}」이(가) 정수실에서 ${(dist / 100).toFixed(1)}m 떨어져 있습니다 (기준 ${MEDICAL_RULES.MAX_PIPE_RUN_CM / 100}m).`, targets: [eq] });
      }
      // 시각적 단절: 장비 주변 100cm 이내를 지나는 배관이 없는 경우
      if (pipes.length && !pipes.some((p) => rectGap(eqBox, bbox(p)) <= 100)) {
        warnings.push({ msg: `「${eq.meta.label}」 주변에 연결된 정수 배관이 없습니다.`, targets: [eq] });
      }
    });

    if (waterEquip.length && !pipes.length) {
      warnings.push({ msg: "정수 배관이 도면에 그려지지 않았습니다. (좌측 '정수 배관 그리기' 또는 자동 배치 사용)", targets: [] });
    }
    return warnings;
  }

  /* ───────── ③ 필수 시설 검증 ───────── */
  function checkRequiredRooms(objects) {
    const missing = [];
    if (!objects.some((o) => o.meta.key === "nurse_station")) missing.push("간호사실");
    if (!objects.some((o) => o.meta.key === "water_treatment")) missing.push("정수실");
    if (!objects.some((o) => o.meta.isDoor)) missing.push("출입문 (자동문/여닫이문)");
    return missing;
  }

  /* ───────── 빨간 테두리 깜빡임 ───────── */
  function stopBlink(canvas) {
    if (blinkTimer) clearInterval(blinkTimer);
    blinkTimer = null;
    blinkTargets.forEach((o) => {
      o.set({ stroke: o._origStroke ?? o.stroke, strokeWidth: o._origStrokeWidth ?? o.strokeWidth, opacity: 1 });
      applyToInnerRect(o, (r) => r.set({ stroke: r._origStroke ?? r.stroke, strokeWidth: r._origStrokeWidth ?? r.strokeWidth }));
    });
    blinkTargets = [];
    canvas.requestRenderAll();
  }

  function applyToInnerRect(o, fn) {
    if (o.type === "group") o.getObjects().forEach((c) => { if (c.type === "rect" || c.type === "group") applyToInnerRect(c, fn); if (c.type === "rect") fn(c); });
  }

  function startBlink(canvas, targets) {
    stopBlink(canvas);
    blinkTargets = targets;
    targets.forEach((o) => {
      applyToInnerRect(o, (r) => {
        r._origStroke = r._origStroke ?? r.stroke;
        r._origStrokeWidth = r._origStrokeWidth ?? r.strokeWidth;
      });
    });
    let on = false;
    blinkTimer = setInterval(() => {
      on = !on;
      targets.forEach((o) => applyToInnerRect(o, (r) =>
        r.set({ stroke: on ? "#ff0000" : (r._origStroke ?? r.stroke), strokeWidth: on ? 8 : (r._origStrokeWidth ?? 3) })
      ));
      canvas.requestRenderAll();
    }, 350);
    // 6초 후 자동 종료
    setTimeout(() => stopBlink(canvas), 6000);
  }

  /* ───────── ④ 병상당 면적 검증 (권고안 6m²) ─────────
   * 전체 바닥 면적 기준의 근사치 — 권고안의 정확한 기준은 간호사실·창고 등을
   * 제외한 환자 점유 공간이므로, 전체 면적으로도 미달이면 확실한 위반이다. */
  function checkAreaPerBed(room, bedCount) {
    if (!bedCount) return null;
    const totalM2 = (room.width / 100) * (room.height / 100);
    const perBed = totalM2 / bedCount;
    return { perBed: Math.round(perBed * 10) / 10, ok: perBed >= MEDICAL_RULES.AREA_PER_BED_M2 };
  }

  /* ───────── 전체 실행 ───────── */
  function run(canvas, objects, room) {
    stopBlink(canvas);
    const spacing = checkBedSpacing(objects);
    const water = checkWaterRuns(objects);
    const missing = checkRequiredRooms(objects);
    const area = room ? checkAreaPerBed(room, spacing.bedCount) : null;

    const badObjects = new Set();
    spacing.violations.forEach((v) => { badObjects.add(v.a); badObjects.add(v.b); });
    water.forEach((w) => w.targets.forEach((t) => badObjects.add(t)));
    if (badObjects.size) startBlink(canvas, [...badObjects]);

    return {
      spacing, water, missing, area,
      pass: !spacing.violations.length && !water.length && !missing.length && (!area || area.ok),
    };
  }

  return { run, rectGap, stopBlink };
})();
