// Unused-catalog and word halves of the copy gate; `npm run lint` runs the gate itself on the real tree.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EN_TERM_RULES, TERM_RULES, catalogIds, checkRuntimeOutput, checkTerms, checkUnused, copyEntries, checkComposer } from "./check-copy.mjs";
import * as copyGate from "./check-copy.mjs";
test("governed commit and dismiss labels must come from the verb table", () => {
  expect(checkComposer("apps/web/src/features/people/ui/lifecycle-sheet.tsx", '<Composer action={{ kind: "TRANSFER", mode: "apply" }} />')).toEqual([]);
  for (const text of ['<Composer commit={{ label: t("bad.commit") }} />', '<Composer dismissLabel={t("common.back")} />', '<Sheet actions={<Button type="submit">{t("bad.commit")}</Button>} />', '<Button onClick={() => run.mutate(undefined)}>{t("bad.commit")}</Button>', '<Button onClick={onClose}>{t("common.back")}</Button>']) {
    expect(checkComposer("apps/web/src/features/people/ui/lifecycle-sheet.tsx", `import { Composer } from "./composer"; ${text}`)).not.toEqual([]);
  }
});

test.each(["lifecycle-sheet", "exit-report", "fix-change", "register-sheet", "new-action-sheet"])("audits %s without a sheet skip list", (name) => {
  const file = `apps/web/src/features/people/ui/${name}.tsx`;
  expect(checkComposer(file, 'const run = useCommand({}); <Sheet />')).not.toEqual([]);
  expect(checkComposer(file, 'const run = useCommand({}); <Sheet actions={<Button type="submit">{t("bad.commit")}</Button>} />')).not.toEqual([]);
  expect(checkComposer(file, '<Composer commit={{ label: "planted" }} />')).not.toEqual([]);
  expect(checkComposer(file, 'import { recordLifecycleEvent } from "../api"; <Button type="submit">{t("empFix.change.commit.planned")}</Button>')).not.toEqual([]);
});

test.each(["entity", "attendance", "access", "org-bulk", "future-module"])("governed sheets in %s use the composer", (feature) => {
  const problems = checkComposer(`apps/web/src/features/${feature}/ui/nested/x-sheet.tsx`, 'const run = useCommand({ run: () => save() }); <Sheet actions={<Button onClick={() => run.mutate(undefined)}>Save</Button>} />');
  expect(problems.join("\n")).toContain("composer.verb");
});

test.each(["effective_from", "effectiveDate", "reason_code", "reasonCode", "approval_id"])("governed page writes carrying %s use the composer", (field) => {
  expect(checkComposer("apps/web/src/features/entity/ui/edit-page.tsx", `const run = useCommand({ run: () => api.POST('/changes', { body: { ${field}: value } }) }); <Form><Button type="submit">Save</Button></Form>`).join("\n")).toContain("composer.verb");
});

test.each(["POST", "PUT", "PATCH", "DELETE"])("audits %s writes and shorthand governed fields", (method) => {
  expect(checkComposer("apps/web/src/features/entity/ui/edit-page.tsx", `fetch('/changes', { method: '${method}', body: JSON.stringify({ reason_code }) }); <form><button type='submit'>Save</button></form>`).join("\n")).toContain("composer.verb");
});

test("read-only sheets and plain page forms stay outside the gate", () => {
  expect(checkComposer("apps/web/src/features/entity/ui/history.tsx", '<Sheet actions={<Button onClick={onClose}>Close</Button>} />')).toEqual([]);
  expect(checkComposer("apps/web/src/features/onboarding/ui/security-contact.tsx", 'const run = useCommand({ run: () => api.POST("/contact", { body: { email } }) }); <Form><Button type="submit">Save</Button></Form>')).toEqual([]);
});

test("composer debt only shrinks and a repaired control cannot borrow its old exception", () => {
  const file = "apps/web/src/features/entity/ui/x-sheet.tsx";
  const findings = checkComposer(file, 'useCommand({}); <Sheet />');
  const allow = findings.map((p: string) => p.replace(/:\d+: composer\.verb:/, ": composer.verb:"));
  expect(copyGate.checkComposerAllow(findings, allow, allow)).toEqual([]);
  expect(copyGate.checkComposerAllow([], allow, allow).join("\n")).toContain("stale");
  expect(copyGate.checkComposerAllow(findings, allow, []).join("\n")).toContain("only shrink");
  expect(copyGate.checkComposerAllow(checkComposer(file, 'useCommand({}); <Sheet title="new bypass" />'), allow, allow)).not.toEqual([]);
});

test.each([["requests.status.DECLINED", "거절됨"], ["requests.status.WITHDRAWN", "철회됨"], ["x.decline", "거절"], ["x.reject", "거절"], ["x.withdraw", "철회"]])("canonical governed verb for %s", (id, text) => {
  expect(checkTerms([{ id, where: "ko/test.ts", text }], [])).not.toEqual([]);
  expect(checkComposer("packages/i18n/src/catalogs/ko/test.ts", `export const ko = {\n "${id}": "${text}",\n};`).join("\n")).toContain("composer.verb");
});

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

test.each([
  ["term.이력", "org.tab.history", "변경 내역", "변경 이력"],
  ["term.미배치", "people.status", "소속 지점 미지정", "미배치"],
  ["term.대기", "home.tab.mine", "내 차례", "대기"],
  ["term.대기", "home.inbox.filter.turn", "내 차례", "대기"],
  ["term.업무함", "attendance.panel.title", "할 일", "업무함"],
  ["term.직원", "people.page.title", "구성원 관리", "직원 관리"],
  ["term.직원", "orgUnit.tab.members", "구성원 {count, number}", "직원 {count, number}"],
  ["term.검색", "org.search.placeholder", "사람 찾기", "직원 검색"],
  ["verb.입력", "org.reason", "사유를 적지 않음", "사유 미입력"],
  ["verb.label", "org.reason", "범위를 정하고 진행합니다", "범위를 지정합니다"],
  ["verb.선택", "org.status", "고름", "선택됨"],
  ["verb.추가", "org.status", "만듦", "생성됨"],
  ["verb.이동", "org.status", "옮김", "이동됨"],
  ["verb.label", "org.reason", "파일을 올립니다", "파일을 첨부합니다"],
  ["verb.부여", "common.denied.granters", "권한을 줄 수 있는 사람", "권한을 부여할 수 있는 담당자"],
  ["prose.위치", "common.reason", "아래 버튼을 선택하십시오", "등록을 선택하십시오"],
  ["prose.위치", "home.reason", "로그아웃은 화면 위쪽에 있습니다.", "로그아웃"],
  ["prose.각주", "org.footnote", "변경 사항은 이력에 남습니다.", ""],
  ["prose.단축키", "org.keyboardHint", "Ctrl+K로 검색합니다", ""],
  ["prose.설정법령", "setup.step.entity.law", "근로기준법 제41조", ""],
  ["prose.정책", "org.policy", "지난 기록은 정정합니다.", ""],
  ["prose.부제", "org.subtitle", "변경 사항은 이력에 남습니다", "조직 구조"],
  ["prose.단계", "org.phase.operating", "운영 중 · 변경 사항은 이력에 남습니다", "운영 중"],
  ["prose.운영시제", "setup.phase.started.detail", "운영을 시작하면 정정으로 바뀝니다.", "운영 중"],
])("maturity %s refuses %s and accepts its replacement", (rule, id, text, near) => {
  expect(checkTerms([entry(id, text)], []).some((p) => p.includes(`: ${rule}:`))).toBe(true);
  expect(checkTerms([entry(id, near)], [])).toEqual([]);
});

test.each([
  ["setup.step.entity", "법인 등록"],
  ["home.empty.partial.title", "볼 수 있는 항목 중에는 처리할 일이 없습니다"],
  ["orgUnit.merge.subtitle", "구성원 {count, number}명"],
])("maturity context accepts %s without an exception", (id, text) => {
  expect(checkTerms([entry(id, text)], [])).toEqual([]);
});

test("contextual glossary preserves body text, find-in-page and task actions", () => {
  for (const [id, text] of [["org.reason", "구성원을 지정합니다"], ["org.findInPage", "페이지에서 찾기"], ["home.action", "할 일 추가"], ["setup.state.todo", "할 일"], ["access.policy", "정책"], ["help.shortcuts.search", "Ctrl+K로 검색합니다"], ["org.subtitle", "직원 {count, number}명"], ["org.reason", "아래 부서에 직원이 있습니다"], ["org.reason", "{name|은는} {where} 아래에 있습니다"]])
    expect(checkTerms([entry(id, text)], []), id).toEqual([]);
});

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

test("runtime-output check fails on a rendered 이(가)/을(를)", () => {
  const problems = checkRuntimeOutput([
    "같은 곳에 부서1이(가) 이미 있습니다",
    "부서3을(를) 추가했습니다",
    "전체 0명이(가) 선택되었습니다",
    "HK-0001을 추가했습니다",
    "E-000002로 변경했습니다",
  ]);
  expect(problems).toHaveLength(3);
  expect(problems[0]).toContain("이(가)");
  expect(problems[1]).toContain("을(를)");
  expect(problems[2]).toContain("이(가)");
});

test("runtime-output check passes when particles are resolved cleanly", () => {
  expect(checkRuntimeOutput(["HK-0001을 전보합니다", "E-000002로 바꿨습니다", "ABC를 등록했습니다"])).toEqual([]);
});

test.each([
  "이(가)", "가(이)", "을(를)", "를(을)", "은(는)", "는(은)",
  "과(와)", "와(과)", "(으)로", "으로(로)", "아(야)", "야(아)",
])("runtime-output check rejects each particle fallback: %s", (written) => {
  const problems = checkRuntimeOutput(`Ω${written}`);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("punct.조사");
  expect(problems[0]).toContain(`Ω${written}`);
});

const cliDirs: string[] = [];
afterAll(() => cliDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function runtimeCli() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(path.join(root, ".copy-cli-"));
  cliDirs.push(dir);
  for (const p of ["scripts/quality", "apps/web/src", "apps/web/public", "packages/api/src", "packages/i18n/src/catalogs/ko", "packages/i18n/src/catalogs/en", "output/nested"])
    mkdirSync(path.join(dir, p), { recursive: true });
  const catalogs = Object.fromEntries(["structure", "people"].map((name) => {
    const file = `packages/i18n/src/catalogs/ko/${name}.ts`;
    const entries = copyEntries(file, readFileSync(path.join(root, file), "utf8")).filter(({ text }) => /\{\w+\|/.test(text));
    return [file, `export const fixture = ${JSON.stringify(Object.fromEntries(entries.map(({ id, text }) => [id, text])), null, 2)};`];
  }));
  catalogs["packages/i18n/src/catalogs/ko/runtime.ts"] = `export const fixture = ${JSON.stringify({
    "runtime.mixed": "mixed: {name|을를} · {note} · {total, number} · {count, plural, =2 {두 건} other {#건}}",
  }, null, 2)};`;
  for (const [file, text] of Object.entries({
    "package.json": '{"type":"module"}',
    "scripts/check-copy.mjs": readFileSync(path.join(root, "scripts/check-copy.mjs"), "utf8"),
    "scripts/quality/ratchet.mjs": readFileSync(path.join(root, "scripts/quality/ratchet.mjs"), "utf8"),
    "scripts/copy-maturity-baseline.json": "{}",
    "scripts/copy-unused-baseline.json": '{"unused":[]}',
    "scripts/copy-terms-allow.json": '{"allow":[]}',
    "scripts/composer-allow.json": '{"allow":[]}',
    "apps/web/public/chunk-guard.js": "",
    "output/clean.txt": "HK-0001을 등록했습니다",
    "output/nested/broken.txt": "HK-0001이(가) 있습니다\nABC을(를) 등록했습니다",
    ...catalogs,
    "apps/web/src/readers.ts": Object.values(catalogs).flatMap(catalogIds).map((id) => `t(${JSON.stringify(id)})`).join("\n"),
  })) writeFileSync(path.join(dir, file), text);
  const josaFile = path.join(dir, "packages/i18n/src/josa.ts");
  const josaSource = readFileSync(path.join(root, "packages/i18n/src/josa.ts"), "utf8");
  writeFileSync(josaFile, josaSource);
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(dir, "scripts/check-copy.mjs"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, QUALITY_BASE: "dev" } });
  return { cli, dir, josaFile, josaSource };
}

test("CLI refuses a planted commit in a newly added sheet without a path exception", () => {
  const { cli, dir } = runtimeCli();
  const folder = "apps/web/src/features/people/ui";
  mkdirSync(path.join(dir, folder), { recursive: true });
  writeFileSync(path.join(dir, folder, "fix-added-sheet.tsx"), '<Composer commit={{ label: "planted" }} />');
  const result = cli();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toMatch(/fix-added-sheet\.tsx(?::1)?: composer\.verb: per-screen commit\/dismiss label/);
});

test("CLI formats mixed text and numeric ICU slots correctly", () => {
  const { cli, josaFile, josaSource } = runtimeCli();
  // Capture the formatted fixture at the existing particle-resolution boundary.
  writeFileSync(josaFile, josaSource.replace("export function resolveJosa(text: string): string {",
    'export function resolveJosa(text: string): string {\n  if (text.startsWith("mixed:")) process.stdout.write(text + "\\n");'));
  const result = cli();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.split("\n")).toEqual(expect.arrayContaining([
    "mixed: HK-0001을 · HK-0001 · 2 · 두 건",
    "mixed: ABC를 · ABC · 2 · 두 건",
    "mixed: 정하늘을 · 정하늘 · 2 · 두 건",
  ]));
});

test("CLI checks rendered files and nested directories and refuses invalid output paths", () => {
  const { cli } = runtimeCli();
  const clean = cli("output/clean.txt");
  expect(clean.status, clean.stderr).toBe(0);
  for (const arg of ["output/nested/broken.txt", "output"]) {
    const result = cli(arg);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("output/nested/broken.txt: punct.조사");
    expect(result.stderr).toContain("이(가)");
    expect(result.stderr).toContain("을(를)");
  }
  for (const arg of ["missing.txt", "--unknown"]) {
    const result = cli(arg);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`${arg}: cannot check runtime output:`);
    expect(result.stderr).toContain("ENOENT");
  }
});

test("CLI checks production particle output without paths", () => {
  const { cli, josaFile, josaSource } = runtimeCli();
  const clean = cli();
  expect(clean.status, clean.stderr).toBe(0);
  // Plant the pre-fix digit fallback in the production helper, without touching the working tree.
  writeFileSync(josaFile, josaSource.replace("return DIGIT_READING[Number(ch)];", "return undefined;"));
  const result = cli();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("runtime (HK-0001): punct.조사");
});

test("default CLI catches unresolved particles in real catalog receipts and refusals", () => {
  const { cli, josaFile, josaSource } = runtimeCli();
  writeFileSync(josaFile, josaSource.replace("const word = latin.toLowerCase();", 'const word = latin.toLowerCase();\n  if (word === "unit") return undefined;'));
  const result = cli();
  expect(result.status, result.stderr).toBe(1);
  for (const id of ["structure.receipt.created", "structure.edit.clash", "people.title.inactive"])
    expect(result.stderr).toContain(`${id} (Unit): punct.조사`);
});

test("CLI scans backend display strings, excluding comments and test fixtures", () => {
  const { cli, dir } = runtimeCli();
  const folder = path.join(dir, "backend/crates/platform/request-context/src/error_i18n");
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "employees.rs");
  writeFileSync(file, '// "퇴사"\npub const MESSAGES: &[(&str, &str)] = &[("exit", "퇴직 기록")];\n#[cfg(test)]\nmod tests { const OLD: &str = "퇴사"; }');
  expect(cli().status).toBe(0);
  writeFileSync(file, 'pub const MESSAGES: &[(&str, &str)] = &[("exit", "퇴사 기록")];');
  const result = cli();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("error_i18n/employees.rs: term.퇴직:");
  writeFileSync(file, '#[cfg(test)]\nmod frozen_keys;\npub const MESSAGES: &[(&str, &str)] = &[("exit", "퇴사 기록")];');
  expect(cli().stderr).toContain("error_i18n/employees.rs: term.퇴직:");
  writeFileSync(file, 'pub const MESSAGES: &[(&str, &str)] = &[("exit", r#"퇴사\n기록"#)];');
  expect(cli().stderr).toContain("error_i18n/employees.rs: term.퇴직:");
});

test("CLI refuses a rendered title assembled from two catalog values", () => {
  const { cli, dir } = runtimeCli();
  const parts = { noun: "구성원", suffix: " 관리" };
  writeFileSync(path.join(dir, "output/title.txt"), `${parts.noun}${parts.suffix}`);
  const result = cli("output/title.txt");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("term.직원");
  writeFileSync(path.join(dir, "output/title.txt"), "직원 관리");
  expect(cli("output/title.txt").status).toBe(0);
});

test("CLI refuses a standing keyboard hint in rendered walk text", () => {
  const { cli, dir } = runtimeCli();
  writeFileSync(path.join(dir, "output/footnote.txt"), "Ctrl+K로 검색합니다");
  expect(cli("output/footnote.txt").stderr).toContain("prose.단축키");
  writeFileSync(path.join(dir, "output/footnote.txt"), "검색 · ⌘K");
  expect(cli("output/footnote.txt").status).toBe(0);
});

test("catalog parsing covers single quotes, templates and multiline values", () => {
  const entries = copyEntries("ko/test.ts", "export const ko = { 'org.title':\n `구성원 관리`, 'org.tab.history': '변경 내역' }; // 퇴사");
  expect(entries.map((e) => e.id)).toEqual(["org.title", "org.tab.history"]);
  expect(checkTerms(entries, []).map((p) => p.split(": ")[1])).toEqual(["term.직원", "term.이력"]);
});

function debtFixture() {
  const fixture = runtimeCli();
  const file = "packages/i18n/src/catalogs/ko/debt.ts";
  const set = (text: string) => writeFileSync(path.join(fixture.dir, file), `export const ko = {\n "org.footnote": ${JSON.stringify(text)},\n};`);
  rmSync(path.join(fixture.dir, "scripts/copy-maturity-baseline.json"));
  set("변경 사항은 이력에 남습니다.");
  writeFileSync(path.join(fixture.dir, "apps/web/src/debt.ts"), 't("org.footnote")');
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", fixture.dir, ...args], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  };
  git("init", "--initial-branch=dev");
  git("add", ".");
  git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", "test fixture");
  return { ...fixture, set, git, baseline: path.join(fixture.dir, "scripts/copy-maturity-baseline.json") };
}

test("CLI resolves seeded and stored composer debt against dev when public/dev is absent", () => {
  const { dir, cli, git } = debtFixture();
  const file = "apps/web/src/features/entity/ui/x-sheet.tsx";
  const source = "useCommand({}); <Sheet />";
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), source);
  rmSync(path.join(dir, "scripts/composer-allow.json"));
  git("add", ".");
  git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", "existing governed sheet");
  const allow = checkComposer(file, source).map((p: string) => p.replace(/:\d+: composer\.verb:/, ": composer.verb:"));
  writeFileSync(path.join(dir, "scripts/composer-allow.json"), JSON.stringify({ allow }));
  expect(cli("--write-baseline").status).toBe(0);
  const env = { ...process.env };
  delete env.QUALITY_BASE;
  const unconfigured = () => spawnSync(process.execPath, [path.join(dir, "scripts/check-copy.mjs")], { cwd: dir, encoding: "utf8", env });
  expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "public/dev"], { cwd: dir }).status).not.toBe(0);
  const seeded = unconfigured();
  expect(seeded.status, seeded.stderr).toBe(0);
  git("add", ".");
  git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", "stored composer debt");
  const stored = unconfigured();
  expect(stored.status, stored.stderr).toBe(0);
});

test("CLI generates exact debt and requires stale entries to shrink", () => {
  const { cli, set, baseline, git } = debtFixture();
  const seeded = cli("--write-baseline");
  expect(seeded.status, seeded.stderr).toBe(0);
  expect(Object.keys(JSON.parse(readFileSync(baseline, "utf8")))).toHaveLength(1);
  git("add", ".");
  git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", "generated baseline");
  expect(cli().status).toBe(0);
  set("");
  expect(cli().stderr).toContain("remove/lower stale baseline");
  expect(cli("--write-baseline").status).toBe(0);
  expect(JSON.parse(readFileSync(baseline, "utf8"))).toEqual({});
  expect(cli().status).toBe(0);
});

test("CLI refuses new debt, changed debt and handwritten baseline growth", async () => {
  const { cli, set, baseline, git } = debtFixture();
  expect(cli("--write-baseline").status).toBe(0);
  git("add", ".");
  git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", "generated baseline");
  const original = readFileSync(baseline, "utf8");
  set("다른 변경 사항도 이력에 남습니다.");
  expect(cli().status).toBe(1);
  expect(cli("--write-baseline").stderr).toContain("baseline must only shrink");
  expect(readFileSync(baseline, "utf8")).toBe(original);
  const { copyDebt } = await import("./check-copy.mjs");
  const file = "packages/i18n/src/catalogs/ko/debt.ts";
  writeFileSync(baseline, JSON.stringify(copyDebt([{ id: "org.footnote", where: file, text: "다른 변경 사항도 이력에 남습니다." }]).counts));
  expect(cli().stderr).toContain("baseline must only shrink");
});

test("first baseline generation refuses debt introduced after the merge base", () => {
  const { cli, set } = debtFixture();
  set("지금 추가한 각주입니다.");
  expect(cli("--write-baseline").stderr).toContain("baseline must only shrink");
});

test("new violations cannot hide behind allow-list growth", () => {
  const { cli, dir, set } = debtFixture();
  set("지금 추가한 각주입니다.");
  writeFileSync(path.join(dir, "scripts/copy-terms-allow.json"), JSON.stringify({ allow: [{ id: "org.footnote", rule: "prose.각주", reason: "planted bypass" }] }));
  expect(cli().stderr).toContain("allow-list must only shrink");
  expect(cli("--write-baseline").stderr).toContain("allow-list must only shrink");
});

test("a renamed key keeps its exception; a new entry or a changed reason is still growth", () => {
  const { cli, dir, git } = debtFixture();
  const allowFile = path.join(dir, "scripts/copy-terms-allow.json");
  const commit = (m: string) => { git("add", "."); git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", m); };
  writeFileSync(allowFile, JSON.stringify({ allow: [{ id: "org.footnote", rule: "prose.각주", reason: "kept use" }] }));
  commit("allow the footnote");
  writeFileSync(path.join(dir, "packages/i18n/src/catalogs/ko/debt.ts"), 'export const ko = {\n "people.footnote": "변경 사항은 이력에 남습니다.",\n};');
  writeFileSync(path.join(dir, "apps/web/src/debt.ts"), 't("people.footnote")');
  writeFileSync(allowFile, JSON.stringify({ allow: [{ id: "people.footnote", rule: "prose.각주", reason: "kept use" }] }));
  expect(cli().stderr).not.toContain("allow-list must only shrink");
  writeFileSync(allowFile, JSON.stringify({ allow: [{ id: "people.footnote", rule: "prose.각주", reason: "a different exception" }] }));
  expect(cli().stderr).toContain("allow-list must only shrink");
  writeFileSync(allowFile, JSON.stringify({ allow: [{ id: "people.footnote", rule: "prose.각주", reason: "kept use" }, { id: "org.other", rule: "prose.각주", reason: "kept use" }] }));
  expect(cli().stderr).toContain("org.other (prose.각주): allow-list must only shrink");
});

test("shell and common have no glossary or standing-prose debt", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { readdirSync } = await import("node:fs");
  const files = ["packages/i18n/src/catalogs/ko/common.ts", ...readdirSync(path.join(root, "packages/i18n/src/catalogs")).filter((f) => /^boot(?:-[\w-]+)?\.ts$/.test(f)).map((f) => `packages/i18n/src/catalogs/${f}`)];
  for (const file of files) {
    const entries = copyEntries(file, readFileSync(path.join(root, file), "utf8")).filter((e) => /^(shell|common)\./.test(e.id));
    expect(checkTerms(entries, []), file).toEqual([]);
  }
  const shared = copyEntries("boot.ts", readFileSync(path.join(root, "packages/i18n/src/catalogs/boot.ts"), "utf8"));
  expect(shared.find((e) => e.id === "shell.jumpLabel")?.text).toBe("검색·이동");
  expect(shared.find((e) => e.id === "shell.jump")?.text).toMatch(/^검색·이동/);
  expect(shared.find((e) => e.id === "common.denied.granters")?.text).toContain("권한을 부여할 수 있는 담당자");
});
