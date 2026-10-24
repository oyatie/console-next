
import type { ReachPage, ReachStep } from "./reach";

/** Where a fact shows: a page of the world, the steps to it (none: the page itself), and the region the value is read in. */
export type Surface = { name: string; page: ReachPage | "register"; via?: readonly ReachStep[]; type?: { combobox: string; text: string }; region?: { role: "complementary" | "region" | "tree" | "grid" | "group" | "navigation" | "heading" | "main"; name?: string } };
export type Fact = { id: string; label: string; record: string; surfaces: readonly Surface[] };

export const FACTS: readonly Fact[] = [
  {
    id: "legal_entity.name",
    label: "법인명(단체명)",
    record: "Entity.legal_entity",
    surfaces: [
      { name: "법인 page · header", page: "entity", region: { role: "heading" } },
      { name: "법인 page · ① card", page: "entity", via: [{ role: "button", name: "사업자등록증", prefix: true }], region: { role: "region", name: "사업자등록증" } },
      { name: "법인 list · row", page: "entities", region: { role: "grid", name: "법인" } },
      { name: "org chart · node", page: "chart", region: { role: "tree" } },
      { name: "인사카드 · placement", page: "card", region: { role: "group", name: "소속" } },
      { name: "직원 명부 · row", page: "people", region: { role: "main" } },
      { name: "직원 등록 · place picker", page: "register", type: { combobox: "둘 곳", text: "가람" }, region: { role: "main" } },
    ],
  },
  {
    id: "legal_entity.short_name",
    label: "약칭",
    record: "Entity.legal_entity",
    surfaces: [
      { name: "법인 page · header", page: "entity", region: { role: "heading" } },
      { name: "법인 list · row", page: "entities", region: { role: "grid", name: "법인" } },
      { name: "org chart · node", page: "chart", region: { role: "tree" } },
      { name: "직원 명부 · row", page: "people", region: { role: "main" } },
      { name: "직원 등록 · place picker", page: "register", type: { combobox: "둘 곳", text: "가람" }, region: { role: "main" } },
    ],
  },
  {
    id: "legal_entity.english_name",
    label: "영문명",
    record: "Entity.legal_entity",
    surfaces: [
      { name: "법인 page · header", page: "entity", region: { role: "heading" } },
      { name: "법인 list · row", page: "entities", region: { role: "grid", name: "법인" } },
      { name: "org chart · node", page: "chart", region: { role: "tree" } },
      { name: "직원 명부 · row", page: "people", region: { role: "main" } },
      { name: "직원 등록 · place picker", page: "register", type: { combobox: "둘 곳", text: "가람" }, region: { role: "main" } },
    ],
  },
  {
    id: "workplace.name",
    label: "사업장 이름",
    record: "Entity.workplace",
    surfaces: [
      { name: "법인 page · 사업장 list", page: "entity", via: [{ role: "button", name: "사업장 1", prefix: true }], region: { role: "grid", name: "사업장" } },
      { name: "법인 page · 사업장 panel", page: "entity", via: [{ role: "button", name: "사업장 1", prefix: true }], region: { role: "complementary" } },
      { name: "법인 page · overview", page: "entity", region: { role: "main" } },
      { name: "org chart · node", page: "chart", region: { role: "tree" } },
      { name: "org chart · side panel", page: "chart", via: [{ role: "treeitem", name: "{workplace}", prefix: true }], region: { role: "complementary" } },
      { name: "인사카드 · placement", page: "card", region: { role: "group", name: "소속" } },
      { name: "직원 명부 · row", page: "people", region: { role: "main" } },
      { name: "직원 등록 · place picker", page: "register", type: { combobox: "둘 곳", text: "가람" }, region: { role: "main" } },
    ],
  },
  {
    id: "employee.emergency_contact",
    label: "비상연락처",
    record: "HR.employee.emergency_contact",
    surfaces: [{ name: "인사카드 · 인적사항", page: "card", region: { role: "region", name: "인적사항" } }],
  },
  {
    id: "employee.record_section",
    label: "학력",
    record: "HR.record_section",
    surfaces: [{ name: "인사카드 · 이력", page: "card", region: { role: "region", name: "이력" } }],
  },
];

/**
 * Editable rows whose surfaces are not mapped yet, each named by its label as its 수정 shows it. Shrink-only, checked by
 * scripts/check-reach.mjs: a label not in the base commit's list (dev) fails as new, a repeated one fails, one that is also
 * in FACTS fails (move it, do not copy it), and each must exist (an editable row the scan finds, or a catalog text a 수정
 * names). Lane: unit ra-facts-propagation (orchestra).
 */
export const UNTRACKED: readonly string[] = [
  // 인사카드
  "성명", "성명 한자 · 영문", "성별", "생년월일", "주소", "휴대전화", "업무 이메일", "개인 이메일", "국적 · 신분증", "근로자 명부 비고", "사진",
  "사번", "직급", "직위", "직책", "직무", "직군", "고용형태", "입사일", "그룹 입사일", "수습", "경력",
  "자격·면허", "병역", "어학", "교육", "포상", "가족",
  // Record-level edits (a section or the whole record from its source), not one fact: 고용 기록, 등록증 보며 (법인)
  "고용 기록", "등록증 보며",
  // 사업장
  "종류", "소재지", "상태", "본점 · 대표", "사업자등록", "개설일", "사업장 대표자", "주생산품", "전화", "팩스", "메일", "우편물 받는 곳", "사업장 코드", "4대보험",
  // 부서
  "부서 이름",
];
