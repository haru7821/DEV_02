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
  // ── 제조사 기술자료의 바닥 점유 치수(cm) — 장비 선택용 ──
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
    width: 300, height: 500,   // 기본 3,000 × 5,000 (참고: 25BED RO실 실측 4,255 × 2,250)
    color: "#9C27B0",
    type: "infrastructure",
  },
  // ── Nurse Station(N.S)와 간호사실은 서로 다른 공간 ──
  // N.S : 환자·장비를 감시하고 주요 업무를 보는 개방형 카운터 (U자 아일랜드)
  nurse_station: {
    label: "Nurse Station (N.S)",
    shortLabel: "N.S",
    width: 588, height: 350,   // 25BED N.S 카운터 실측 5,878 × 3,502
    color: "#FF9800",
    type: "room",
  },
  // 간호사실 : 간호사 탈의·휴게·회의용 별도 실 (참고 도면의 '간호사 탈의실(휴게실)')
  nurse_room: {
    label: "간호사실 (탈의·휴게)",
    width: 350, height: 300,
    color: "#FFCC80",
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
    width: 200, height: 200,   // 장애인 접근 가능 규격 (2.0×2.0m)
    color: "#607D8B",
    type: "room",
  },
  storage: {
    label: "창고",
    width: 300, height: 300,   // 소모품 보관 (3.0×3.0m)
    color: "#9E9E9E",
    type: "room",
  },
  isolation_room: {
    label: "격리실 (감염관리)",
    width: 400, height: 350,   // 27bed 격리실(중환자)·격리실 2실 구성 기준 (도면 치수 미기입)
    color: "#F44336",
    type: "room",
    isolation: true,
  },
  // ── 실제 인공신장실 도면(대동병원 등)에서 확인되는 부속실 ──
  waiting_area: {
    label: "환자 대기실",
    width: 400, height: 300,   // 대기 의자 6~8석 (4.0×3.0m)
    color: "#FFC107",
    type: "room",
  },
  treatment_room: {
    label: "간호처치실",
    width: 300, height: 300,
    color: "#FFB74D",
    type: "room",
  },
  pharmacy_room: {
    label: "조제실",
    width: 250, height: 250,
    color: "#BA68C8",
    type: "room",
  },
  linen_room: {
    label: "린넨실",
    width: 408, height: 225,   // 25BED 린넨실 실측 4,076 × 2,250
    color: "#A1887F",
    type: "room",
  },
  laundry_room: {
    label: "세탁실",
    width: 250, height: 250,
    color: "#4DB6AC",
    type: "room",
  },
  waste_room: {
    label: "오물처리실",
    width: 200, height: 250,   // 내부/외부 양방향 반출 (2.0×2.5m)
    color: "#8D6E63",
    type: "room",
  },
  clean_room: {
    label: "기구세척실",
    width: 250, height: 250,
    color: "#26A69A",
    type: "room",
  },
  consult_room: {
    label: "상담실",
    width: 250, height: 300,
    color: "#90A4AE",
    type: "room",
  },
  office_room: {
    label: "과장실 (사무실)",
    width: 300, height: 300,
    color: "#B0BEC5",
    type: "room",
  },
  // ── 업로드 도면(reference-plans/)에서 확인되는 부속실 ──
  repair_room: {
    label: "투석기 정비실",
    width: 250, height: 250,   // 27bed 「장비보관 등」·25BED 기계실 상당
    color: "#78909C",
    type: "room",
  },
  training_room: {
    label: "자가투석 교육실",
    width: 350, height: 320,   // 27bed 복막실/교육 공간 상당 (도면 치수 미기입)
    color: "#AED581",
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
  // ── 가구/위생기구 (실별 기본 오브젝트, category:"furn") ──
  station_desk2: {
    label: "간호 데스크 (2인 책상+의자)",
    shortLabel: "2인",
    width: 108, height: 80,   // 25BED N.S 카운터 5,878 ÷ 5조 = 1조당 1,180mm 피치
    color: "#F57C00",
    type: "furniture", category: "furn",
    symbol: "desk2",          // 책상 + 의자 2개 기호 (canvas.js)
  },
  counter_desk: {
    label: "카운터/데스크",
    shortLabel: "DESK",
    width: 180, height: 60,
    color: "#FF8F00",
    type: "furniture", category: "furn",
  },
  cabinet: {
    label: "수납장/락커",
    shortLabel: "CAB",
    width: 120, height: 45,
    color: "#8D6E63",
    type: "furniture", category: "furn",
  },
  chair_wait: {
    label: "대기 의자 (3연)",
    shortLabel: "의자×3",
    width: 150, height: 50,
    color: "#FDD835",
    type: "furniture", category: "furn",
  },
  toilet_bowl: {
    label: "변기",
    shortLabel: "WC",
    width: 40, height: 70,
    color: "#78909C",
    type: "furniture", category: "furn",
  },
  washbasin: {
    label: "세면대",
    shortLabel: "세면",
    width: 55, height: 45,
    color: "#90A4AE",
    type: "furniture", category: "furn",
  },
  sink: {
    label: "세척 싱크",
    shortLabel: "SINK",
    width: 100, height: 55,
    color: "#4DB6AC",
    type: "furniture", category: "furn",
  },
  shelf: {
    label: "선반",
    shortLabel: "SHELF",
    width: 150, height: 40,
    color: "#A1887F",
    type: "furniture", category: "furn",
  },
  // ── 구조 기둥: 속성 패널에서 크기(mm) 조절. 잠금(🔒)하면 Auto Modeling이
  //    기둥을 피해서 배치한다 ──
  pillar: {
    label: "기둥 (구조)",
    shortLabel: "기둥",
    width: 50, height: 50,     // 기본 500×500mm — 속성 패널에서 조절
    color: "#37474F",
    type: "equipment",
    symbol: "pillar",
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
 * 기본 규격 상수 (validation.js·canvas.js에서 사용)
 *
 * 기준: 업로드된 실측 도면 `reference-plans/` 2장을 표준으로 삼는다.
 *  - 25BED.png : 대동병원 인공신장실 25EA
 *  - 27bed.png : 27병상 인공신장실
 * 아래 값은 두 도면에 기입된 치수를 직접 읽어 정리한 것이며, 도면에 치수가
 * 없는 항목만 국내 기준(보건복지부·대한신장학회 권고안)을 보조로 사용한다.
 * 해외 기준(FGI·AusHFG·CDC 등)은 기준에서 제외했다.
 *
 * ── 도면 실측값 (mm) ──
 *  병상 모듈 피치 : 1,800(27bed) · 1,500 / 1,520 / 1,600 / 1,700(25BED)
 *  마주보는 병상 간 : 800(25BED)
 *  배관 콘솔 두께 : 640(27bed)
 *  병상 열 사이 통로 : 1,160 · 1,360(27bed) · 1,280 · 1,400(25BED)
 *  중앙 로비(주 동선) : 3,370(25BED)
 *  N.S 카운터 : 5,878 × 3,502 — 2인 데스크 5조(25BED)
 *  RO실(정수실) 4,255 × 2,250 · 린넨실 4,076 × 2,250 · 기계실 3,970 × 3,075(25BED)
 *  전면 부속실 블록 폭 : 3,980(27bed)
 */
const MEDICAL_RULES = {
  // ── 검증 기준 ──
  MIN_BED_GAP_CM: 80,       // 마주보는 병상 사이 최소 간격 (25BED 실측 800mm)
  FOOT_WALL_CLEARANCE_CM: 80, // 침대 발쪽-벽 최소 이격 (도면 병상 열 앞 통로 최소치)
  AREA_PER_BED_M2: 6,       // 병상당 최소 면적 — 도면에 없어 국내 권고안 6m² 사용
  MAX_PIPE_RUN_CM: 2500,    // 정수실 ↔ requiresWater 장비 최대 배관 동선 (25m)
  BED_WALL_CLEARANCE_CM: 60,// 병상-벽 최소 여유 (자동 배치 시 참고)
  // ── 도면 실측 기본 치수 (cm) ──
  MODULE_PITCH_CM: 180,     // 병상 모듈 폭 = 침대+투석기 (27bed 1,800)
  MODULE_DEPTH_CM: 220,     // 병상 모듈 길이 (침대 길이 기준)
  CONSOLE_DEPTH_CM: 64,     // 배관 콘솔 두께 (27bed 640)
  SUB_AISLE_CM: 130,        // 보조통로 기본 — 도면 1,160~1,400의 중앙값
  MIN_AISLE_CM: 116,        // 통로 최소 (27bed 최소 실측 1,160)
  MAIN_CORRIDOR_CM: 337,    // 주통로(중앙 로비) 기본 (25BED 3,370)
  NS_DESK_PITCH_CM: 118,    // N.S 2인 데스크 1조 피치 (25BED 5,878 ÷ 5조)
  NS_DEPTH_CM: 150,         // N.S 카운터 블록 깊이 (25BED 3,502은 전면 작업공간 포함)
};
