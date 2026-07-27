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
  /**
   * 등맞댐(back-to-back) 예외: 두 병상 사이 간격 구역에 배관 콘솔이 있으면
   * 머리맡이 콘솔로 분리된 정상 배치로 간주한다 (실제 도면의 800mm 백투백 구조).
   */
  function consoleBetween(a, b, consoles) {
    const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    if (xOverlap <= 0) return false; // 좌우로 떨어진 병상은 해당 없음
    const gapTop = Math.min(a.bottom, b.bottom);
    const gapBottom = Math.max(a.top, b.top);
    if (gapTop > gapBottom) return false;
    return consoles.some((c) =>
      c.top >= gapTop - 10 && c.bottom <= gapBottom + 10 &&
      c.right > Math.max(a.left, b.left) && c.left < Math.min(a.right, b.right));
  }

  /**
   * 모듈 밀착 예외: 병상 모듈(침대+장비 존)끼리 좌우로 붙여 배치한 경우
   * (참고 도면의 1800mm 모듈 피치). 침대 사이는 모듈 내 장비 존이 분리한다.
   */
  function moduleAdjacent(a, b, oa, ob) {
    if (oa.meta.key !== "bed_unit" || ob.meta.key !== "bed_unit") return false;
    const yOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (yOverlap < 100) return false; // 같은 행에서 나란히 붙은 경우만
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    return dx <= 10;
  }

  function checkBedSpacing(objects) {
    const beds = objects.filter(isBed);
    const consoles = objects.filter((o) => o.meta.key === "bed_console").map(bbox);
    const violations = [];
    for (let i = 0; i < beds.length; i++) {
      for (let j = i + 1; j < beds.length; j++) {
        const ba = bbox(beds[i]), bb = bbox(beds[j]);
        const gap = rectGap(ba, bb);
        // 허용 오차 2cm: 바운딩 박스가 테두리 선 두께를 포함해 실제보다
        // 약간 크게 잡히는 렌더링 오차를 보정한다
        if (gap < MEDICAL_RULES.MIN_BED_GAP_CM - 2 &&
            !consoleBetween(ba, bb, consoles) &&
            !moduleAdjacent(ba, bb, beds[i], beds[j])) {
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
        warnings.push({ msg: `「${eq.meta.label}」이(가) 정수실에서 ${Math.round(dist * 10).toLocaleString()}mm 떨어져 있습니다 (기준 ${(MEDICAL_RULES.MAX_PIPE_RUN_CM * 10).toLocaleString()}mm).`, targets: [eq] });
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

  /* ───────── ②-2 침대 발쪽-벽 이격 검증 (최소 800mm) ─────────
   * 병상 모듈의 발쪽(머리 반대편)이 외벽과 80cm 미만이면 통행·처치 공간
   * 부족으로 경고한다. meta.headDown=true면 발쪽이 위(top), 아니면 아래(bottom). */
  function checkFootClearance(objects, room) {
    if (!room) return [];
    const min = MEDICAL_RULES.FOOT_WALL_CLEARANCE_CM;
    // 발 방향에 있는 '벽 역할' 장애물: 외벽 + 부속실/기반설비 실
    const walls = objects.filter((o) => ["room", "infrastructure"].includes(o.meta.type)).map(bbox);
    const bad = [];
    objects.filter((o) => o.meta.key === "bed_unit").forEach((b) => {
      const r = bbox(b);
      let footGap;
      if (b.meta.headDown) { // 발쪽 = 위
        footGap = r.top; // 상단 외벽까지
        walls.forEach((w) => {
          if (w.right > r.left && w.left < r.right && w.bottom <= r.top + 5) {
            footGap = Math.min(footGap, r.top - w.bottom);
          }
        });
      } else {               // 발쪽 = 아래
        footGap = room.height - r.bottom; // 하단 외벽까지
        walls.forEach((w) => {
          if (w.right > r.left && w.left < r.right && w.top >= r.bottom - 5) {
            footGap = Math.min(footGap, w.top - r.bottom);
          }
        });
      }
      if (footGap < min) {
        bad.push({ msg: `「${b.meta.name ?? b.meta.label}」 발쪽-벽 이격 ${Math.round(footGap * 10)}mm < 기준 ${min * 10}mm`, targets: [b] });
      }
    });
    return bad;
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
    const foot = checkFootClearance(objects, room);
    const missing = checkRequiredRooms(objects);
    const area = room ? checkAreaPerBed(room, spacing.bedCount) : null;

    const badObjects = new Set();
    spacing.violations.forEach((v) => { badObjects.add(v.a); badObjects.add(v.b); });
    water.forEach((w) => w.targets.forEach((t) => badObjects.add(t)));
    foot.forEach((w) => w.targets.forEach((t) => badObjects.add(t)));
    if (badObjects.size) startBlink(canvas, [...badObjects]);

    return {
      spacing, water, foot, missing, area,
      pass: !spacing.violations.length && !water.length && !foot.length && !missing.length && (!area || area.ok),
    };
  }

  return { run, rectGap, stopBlink };
})();
