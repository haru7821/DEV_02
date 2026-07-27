/**
 * assets.js — 장비/실(室) 에셋 데이터 정의
 *
 * 좌표계: 캔버스 1px = 실제 1cm (축척 1:1 모델, 화면 표시는 zoom으로 조절)
 * MTS(Medical Technical Service) 설치 기준과 실제 장비 규격(cm)을 반영한다.
 *  - requiresWater : 정수(RO) 배관 연결이 필수인 장비
 *  - isolationCapable : 감염(격리) 구역 배치가 가능한 장비
 *  - type : "equipment"(장비) | "room"(실) | "infrastructure"(기반설비)
 */
const equipmentData = {
  dialysis_bed: {
    label: "투석 침대",
    width: 120, height: 220,
    color: "#4CAF50",
    type: "equipment",
    requiresWater: true,
    isolationCapable: true,
  },
  dialysis_machine: {
    label: "투석기 (Vantive)",
    shortLabel: "투석기",           // 캔버스 표시용 (사각형 안에 들어가는 짧은 이름)
    width: 50, height: 70,          // Vantive 급 투석기 바닥 점유 규격
    color: "#2196F3",
    type: "equipment",
    requiresWater: true,
  },
  patient_monitor: {
    label: "환자 모니터",
    shortLabel: "모니터",
    width: 40, height: 40,
    color: "#03A9F4",
    type: "equipment",
  },
  water_treatment: {
    label: "정수실 (Water Treatment)",
    width: 300, height: 400,
    color: "#9C27B0",
    type: "infrastructure",
  },
  nurse_station: {
    label: "간호사실",
    width: 300, height: 200,
    color: "#FF9800",
    type: "room",
  },
  changing_room: {
    label: "탈의실",
    width: 200, height: 250,
    color: "#795548",
    type: "room",
  },
  toilet: {
    label: "화장실",
    width: 150, height: 200,
    color: "#607D8B",
    type: "room",
  },
  storage: {
    label: "창고",
    width: 200, height: 200,
    color: "#9E9E9E",
    type: "room",
  },
  isolation_room: {
    label: "격리실 (감염관리)",
    width: 350, height: 300,
    color: "#F44336",
    type: "room",
    isolation: true,
  },
};

/** 의료 규격 상수 (validation.js에서 사용) */
const MEDICAL_RULES = {
  MIN_BED_GAP_CM: 100,      // 병상 간 최소 이격 거리 (테두리 기준 1.0m)
  MAX_PIPE_RUN_CM: 2500,    // 정수실 ↔ requiresWater 장비 최대 배관 동선 (25m)
  BED_WALL_CLEARANCE_CM: 60 // 병상-벽 최소 여유 (자동 배치 시 참고)
};
