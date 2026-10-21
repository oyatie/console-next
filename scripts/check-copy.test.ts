// Unused-catalog and word halves of the copy gate; `npm run lint` runs the gate itself on the real tree.
import { expect, test } from "vitest";
import { EN_TERM_RULES, TERM_RULES, catalogIds, checkTerms, checkUnused, copyEntries } from "./check-copy.mjs";

const src = [`t("org.title"); t(\`exit.action.\${k}\`); const id = \`org.change.event.\${e.action}\`;`];

test("reads the quoted keys of a catalog file", () => {
  expect(catalogIds(`export const koOrg = {\n  "org.title": "조직",\n  'org.tab': "보기",\n};`)).toEqual(["org.title", "org.tab"]);
});

test("passes ids used as a literal or covered by a namespaced template, dotted runtime values included", () => {
  expect(checkUnused(["org.title", "exit.action.SUBMIT", "org.change.event.step.decide"], src, [])).toEqual([]);
});

test("fails on an id no source uses, naming it", () => {
  const problems = checkUnused(["org.title", "org.orphan", "exit.actionable"], src, []);
  expect(problems.map((p) => p.split(":")[0])).toEqual(["org.orphan", "exit.actionable"]);
});

test("a template must start with a namespace to count", () => {
  expect(checkUnused(["org.orphan"], ["t(`${ns}.orphan`)"], [])).toHaveLength(1);
});

test("baselined unused ids pass; the baseline fails once an entry is used or removed", () => {
  expect(checkUnused(["org.title", "live.later"], src, ["live.later"])).toEqual([]);
  const problems = checkUnused(["org.title"], src, ["org.title", "live.gone"]);
  expect(problems).toHaveLength(2);
  expect(problems[0]).toContain('"org.title" is now used');
  expect(problems[1]).toContain('"live.gone" is no longer a catalog id');
});

const entry = (id: string, text: string) => ({ id, where: "ko/test.ts", text });

test("a planted 「고치기」 fails, naming the id, the rule and the canonical verb", () => {
  const problems = checkTerms([entry("entityRecord.action.fixOf", "대표전화 고치기")], []);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("entityRecord.action.fixOf: verb.수정: 「고치」 → 수정");
});

test.each([
  ["verb.변경", "종류 바꾸기"], ["verb.이동", "부서 옮기기"], ["verb.선택", "범위를 고르십시오"], ["verb.추가", "역할 만들기"],
  ["verb.삭제", "규칙 지우기"], ["verb.제외", "이 줄 빼기"], ["verb.통합", "합치기"], ["verb.입력", "사유를 적으십시오"],
  ["verb.label", "대표 사업장 정하기"], ["verb.하기", "바로 시작하기"], ["register.합니다체", "정정을 요청하세요."],
  ["term.퇴직", "퇴사일"], ["term.인사카드", "인사기록카드"], ["term.외래어", "테넌트 개설"], ["term.계정", "다른 사용자"],
  ["punct.조사", "{label}을(를) 넣었습니다"], ["punct.조사", "{number}(으)로 변경했습니다"], ["punct.따옴표", "이력에 '정정'으로 남습니다"],
])("%s fails on 「%s」", (rule, text) => {
  expect(checkTerms([entry("x.y", text)], []).map((p) => p.split(": ")[1])).toContain(rule);
});

test("the established UI terms and canonical words pass", () => {
  for (const text of ["대표전화 수정", "페이지를 새로 고치십시오.", "붙여넣기", "목록 붙여 넣으면", "내보내기", "미리보기", "되돌리기", "닫기", "필요 서류 확인 필요", "상태가 퇴직으로 바뀝니다"])
    expect(checkTerms([entry("x.y", text)], []), text).toEqual([]);
});

test("「회사 도메인」 (decision #33) passes; every other 회사 in the same line still fails", () => {
  expect(checkTerms([entry("x.y", "회사 도메인을 입력하십시오")], [])).toEqual([]);
  for (const text of ["회사 이메일", "회사 도메인과 회사 이메일", "회사도메인", "회사 설정"])
    expect(checkTerms([entry("x.y", text)], []).map((p) => p.split(": ")[1]), text).toContain("term.회사");
});

test("an allowlisted use passes; an allowlist entry that no longer matches fails", () => {
  const allow = [{ id: "entity.field.incorporatedOn", rule: "term.회사", reason: "legal field name" }];
  expect(checkTerms([entry("entity.field.incorporatedOn", "회사성립연월일")], allow)).toEqual([]);
  expect(checkTerms([entry("entity.field.incorporatedOn", "법인성립연월일")], allow)[0]).toContain("no longer matches");
  expect(checkTerms([entry("tenants.title", "테넌트")], [{ id: "tenants.*", rule: "term.외래어", reason: "prefix" }])).toEqual([]);
});

test("reads Korean catalog values only, never keys or English lines", () => {
  const text = `// its 고치기 sheets\n  "a.fix": "고치기",\n  "a.fix": "Edit",\n  "a.quote": "\\"옮기기\\" 안내",`;
  expect(copyEntries("boot.ts", text).map((e) => [e.id, e.text])).toEqual([["a.fix", "고치기"], ["a.quote", "\"옮기기\" 안내"]]);
  expect(TERM_RULES.every((r) => r.use.length > 0)).toBe(true);
});

test.each([
  ["근기법 제17조", "근로기준법"],
  ["건보법에 따른 신고", "국민건강보험법"],
  ["개보법 제23조", "개인정보 보호법"],
  ["근참법 제4조", "근로자참여 및 협력증진에 관한 법률"],
  ["고보법 제15조", "고용보험법"],
  ["산재법 제6조", "산업재해보상보험법"],
  ["PIPA §23", "개인정보 보호법"],
  ["LSA 제17조", "근로기준법"],
  ["고시", "개인정보의 안전성 확보조치 기준"],
  ["근거 법령: 고시", "개인정보의 안전성 확보조치 기준"],
  ["고시 제8조", "개인정보의 안전성 확보조치 기준"],
  ["고시 §8", "개인정보의 안전성 확보조치 기준"],
  ["「고시」", "개인정보의 안전성 확보조치 기준"],
  ["고시에 따라 보관합니다", "개인정보의 안전성 확보조치 기준"],
])("refuses the informal law name in 「%s」 and gives %s", (text, title) => {
  const problems = checkTerms([entry("law.citation", text)], []);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("ko/test.ts law.citation: term.법령명:");
  expect(problems[0]).toContain(`→ ${title}:`);
});

test.each([
  ["PIPA §23", "Personal Information Protection Act"],
  ["LSA art. 17(2)", "Labor Standards Act"],
  ["LSA Decree art. 7-2", "Labor Standards Act"],
])("refuses the English acronym in %s and gives %s", (text, title) => {
  const problems = checkTerms([{ id: "law.citation", where: "en/test.ts", text }], [], EN_TERM_RULES);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("en/test.ts law.citation: term.법령명:");
  expect(problems[0]).toContain(`→ ${title}:`);
});

test.each([
  "근로기준법 제17조", "국민건강보험법", "개인정보 보호법 제23조",
  "근로자참여 및 협력증진에 관한 법률 · 근로자참여법", "고용보험법",
  "산업재해보상보험법 · 산재보험법", "개인정보의 안전성 확보조치 기준 제8조",
  "결과 고시", "결과를 고시합니다", "고시되었습니다", "고시원", "국토교통부 고시 제2025-10호",
  "PIPAware", "LSAT", "Personal Information Protection Act §23", "Labor Standards Act art. 17(2)",
])("passes formal names and non-statute uses: %s", (text) => {
  expect(checkTerms([entry("law.citation", text)], [])).toEqual([]);
  expect(checkTerms([entry("law.citation", text)], [], EN_TERM_RULES)).toEqual([]);
});

test.each(["ko/test.ts", "en/test.ts"])("reads acronym-only values in %s, ignoring keys and comments", (file) => {
  const text = `// "law.comment": "PIPA",\n  "law.citation": "PIPA §23",\n  "PIPA": "Formal title",`;
  const entries = copyEntries(file, text);
  expect(entries.map((e) => [e.id, e.text])).toEqual([["law.citation", "PIPA §23"], ["PIPA", "Formal title"]]);
  expect(checkTerms(entries, [], file.startsWith("en/") ? EN_TERM_RULES : TERM_RULES)).toHaveLength(1);
});

test("English law rules preserve English copy outside legal names", () => {
  expect(checkTerms(copyEntries("en/test.ts", '"law.help": "HR users can edit the company record!",'), [], EN_TERM_RULES)).toEqual([]);
});
