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
  // ── 웹 조사 기반 실측 투석기 (제조사 기술자료의 바닥 점유 치수, cm) ──
  fresenius_4008s: {
    label: "투석기 (Fresenius 4008S)",
    shortLabel: "4008S",
    width: 50, height: 65,      // 500×650mm, H1370 (제조사 기술사양)
    color: "#1E88E5",
    type: "equipment",
    requiresWater: true,
  },
  fresenius_6008: {
    label: "투석기 (Fresenius 6008)",
    shortLabel: "6008",
    width: 52, height: 78,      // 베이스 520×780mm, H1680 (6008 CAREsystem Technical Data)
    color: "#3949AB",
    type: "equipment",
    requiresWater: true,
  },
  baxter_ak98: {
    label: "투석기 (Baxter/Vantive AK98)",
    shortLabel: "AK98",
    width: 59, height: 62,      // 스탠드 585×620mm, H1305, 약 70kg (AK 98 Brochure)
    color: "#00838F",
    type: "equipment",
    requiresWater: true,
  },
  nipro_surdial_x: {
    label: "투석기 (Nipro Surdial X)",
    shortLabel: "Surdial X",
    width: 48, height: 90,      // 480×895mm, H1625 (MedicalExpo 사양서)
    color: "#5E35B1",
    type: "equipment",
    requiresWater: true,
  },
  dialysis_chair: {
    label: "투석 체어 (리클라이닝)",
    shortLabel: "체어",
    width: 76, height: 169,     // 눕힌 상태 755×1690mm (전동형은 650×2010mm)
    color: "#7CB342",
    type: "equipment",
    requiresWater: true,
    isolationCapable: true,
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
  // ── 실제 인공신장실 도면(대동병원 등)에서 확인되는 부속실 ──
  waiting_area: {
    label: "환자 대기실",
    width: 300, height: 250,
    color: "#FFC107",
    type: "room",
  },
  treatment_room: {
    label: "간호처치실",
    width: 250, height: 200,
    color: "#FFB74D",
    type: "room",
  },
  pharmacy_room: {
    label: "조제실",
    width: 200, height: 200,
    color: "#BA68C8",
    type: "room",
  },
  linen_room: {
    label: "린넨실",
    width: 200, height: 200,
    color: "#A1887F",
    type: "room",
  },
  laundry_room: {
    label: "세탁실",
    width: 200, height: 200,
    color: "#4DB6AC",
    type: "room",
  },
  waste_room: {
    label: "오물처리실",
    width: 150, height: 200,
    color: "#8D6E63",
    type: "room",
  },
  clean_room: {
    label: "기구세척실",
    width: 200, height: 200,
    color: "#26A69A",
    type: "room",
  },
  consult_room: {
    label: "상담실",
    width: 200, height: 200,
    color: "#90A4AE",
    type: "room",
  },
  office_room: {
    label: "과장실 (사무실)",
    width: 250, height: 200,
    color: "#B0BEC5",
    type: "room",
  },
  // ── 배관 콘솔: 투석 장비 뒤(머리맡 벽면)를 따라 급수/배수 배관이 지나가는
  //    설비 덕트. 두께(깊이)는 상단 네비 "콘솔(mm)" 입력으로 지정한다. ──
  bed_console: {
    label: "배관 콘솔 (Console)",
    shortLabel: "CONSOLE",
    width: 400, height: 25,     // height(두께)는 setConsoleDepth 설정값으로 대체됨
    color: "#607D8B",
    type: "equipment",
    symbol: "console",
  },
  // ── 정수실 내부 설비 (실제 정수실 시공 도면 참고, category:"wt") ──
  // 처리 순서: 원수 → Multimedia → Softner → Carbon → 5μ필터 → RO(CWP) → 공급
  cwp106h: {
    label: "RO 시스템 (CWP106H)",
    shortLabel: "CWP106H",
    width: 220, height: 90,
    color: "#7B1FA2",
    type: "equipment", category: "wt",
  },
  cwp66: {
    label: "RO 시스템 (CWP66)",
    shortLabel: "CWP66",
    width: 130, height: 80,
    color: "#8E24AA",
    type: "equipment", category: "wt",
  },
  multimedia_filter: {
    label: "여과탱크 (Multimedia)",
    shortLabel: "MM",
    width: 70, height: 70,
    color: "#37474F",
    type: "equipment", category: "wt",
    symbol: "tank",
  },
  softner_filter: {
    label: "연수탱크 (Softner)",
    shortLabel: "SF",
    width: 70, height: 70,
    color: "#455A64",
    type: "equipment", category: "wt",
    symbol: "tank",
  },
  carbon_filter: {
    label: "카본탱크 (Carbon)",
    shortLabel: "CA",
    width: 70, height: 70,
    color: "#263238",
    type: "equipment", category: "wt",
    symbol: "tank",
  },
  filter_5u: {
    label: "5μ 필터",
    shortLabel: "5μ",
    width: 30, height: 30,
    color: "#546E7A",
    type: "equipment", category: "wt",
    symbol: "circle",
  },
  pump_unit: {
    label: "이송펌프 (Auto/Manual)",
    shortLabel: "PUMP",
    width: 90, height: 45,
    color: "#0277BD",
    type: "equipment", category: "wt",
    symbol: "pump",
  },
  heating_system: {
    label: "Heating System",
    shortLabel: "Heating",
    width: 180, height: 110,
    color: "#E65100",
    type: "equipment", category: "wt",
  },
  control_box: {
    label: "Control Box",
    shortLabel: "CTRL",
    width: 35, height: 80,
    color: "#263238",
    type: "equipment", category: "wt",
  },
  main_panel: {
    label: "Main Panel (3상4선식 380V)",
    shortLabel: "MAIN 380V",
    width: 100, height: 35,
    color: "#B71C1C",
    type: "equipment", category: "wt",
  },
  raw_water_inlet: {
    label: "원수 인입 40mm",
    shortLabel: "원수40",
    width: 20, height: 20,
    color: "#1565C0",
    type: "equipment", category: "wt",
    symbol: "circle",
  },
  drain_natural: {
    label: "자연배수 75mm",
    shortLabel: "D75",
    width: 20, height: 20,
    color: "#607D8B",
    type: "equipment", category: "wt",
    symbol: "circle",
  },
  drain_forced: {
    label: "강제배수 75mm (벽에서 20mm)",
    shortLabel: "FD75",
    width: 20, height: 20,
    color: "#4E342E",
    type: "equipment", category: "wt",
    symbol: "circle",
  },
  outlet_220v: {
    label: "220V 콘센트 (4구, H:2M)",
    shortLabel: "220V",
    width: 35, height: 12,
    color: "#F9A825",
    type: "equipment", category: "wt",
  },
  // ── 건축 코어 (PS/EPS 샤프트) : 사각형 + 대각선 X 기호로 렌더링 ──
  core: {
    label: "CORE (PS/EPS)",
    width: 200, height: 200,
    color: "#455A64",
    type: "infrastructure",
    symbol: "cross",          // canvas.js addEquipment에서 X 대각선 기호로 표현
  },
};

/**
 * 배관 타입 정의 — 급수(Inlet)/배수(Drain) 2계통 구분
 *  - color : 배관 선 색상 (도면 모드에서도 유지)
 *  - dash  : 점선 패턴 (null = 실선)
 */
const pipeTypes = {
  inlet: { label: "급수 (Inlet)", color: "#1565C0", dash: null },
  drain: { label: "배수 (Drain)", color: "#6D4C41", dash: [12, 8] },
};

/**
 * 문/개구부 데이터 — 건축 도면 기호로 렌더링 (canvas.js의 addDoor 참조)
 *  - swing_door        : 문짝 + 1/4 원호 개폐 궤적 (여닫이 외짝)
 *  - double_swing_door : 좌우 대칭 두 짝 (주 출입구 등)
 *  - auto_door         : 좌우 슬라이딩 패널 2장 (AUTO 표기)
 *  - sliding_door      : 미닫이 외짝
 */
const doorData = {
  swing_door: { label: "여닫이문 (외짝)", width: 90, color: "#37474F" },
  double_swing_door: { label: "여닫이문 (양짝)", width: 180, color: "#37474F" },
  auto_door: { label: "자동문", width: 180, color: "#0288D1" },
  sliding_door: { label: "미닫이문", width: 120, color: "#546E7A" },
};

/**
 * 의료 규격 상수 (validation.js에서 사용)
 * 근거 (웹 조사):
 *  - 보건복지부·대한신장학회 「인공신장실 설치 및 운영 세부기준 권고안」:
 *    침상 간 이격 0.8m 이상, 병상 1개당 6m² 이상(간호사실·창고 등 제외한
 *    환자 점유 공간 기준), 격리실 1개 이상
 *  - 의료법 시행규칙 [별표4] 입원실: 병상 간 1.5m(신·증축) / 기존 시설 특례 1.0m
 *  - 해외 참고: FGI 4ft(122cm), AusHFG 투석 베이 9m²
 * 본 도구는 보수적으로 1.0m(의료법 특례 수준)를 기본값으로 사용한다.
 */
const MEDICAL_RULES = {
  MIN_BED_GAP_CM: 100,      // 병상 간 최소 이격 (권고안 0.8m, 의료법 특례 1.0m → 1.0m 채택)
  AREA_PER_BED_M2: 6,       // 병상당 최소 면적 (권고안 6m²)
  MAX_PIPE_RUN_CM: 2500,    // 정수실 ↔ requiresWater 장비 최대 배관 동선 (25m)
  BED_WALL_CLEARANCE_CM: 60 // 병상-벽 최소 여유 (자동 배치 시 참고)
};
