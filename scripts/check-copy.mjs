#!/usr/bin/env node
// Copy gate: user-facing text lives only in packages/i18n catalogs, every catalog id has a reader, and the Korean
// copy uses the words of docs/design/copy-conventions.md (3, below).
//   1. Fails on any Hangul literal in app/package source (tests and catalogs excepted).
//   2. Fails on a catalog id (ko/<ns>.ts, boot.ts and its boot-<part>.ts fragments) that no source uses.
//      An id counts as used when it appears as a quoted literal, or matches a template literal that starts with a namespace
//      (`exit.action.${k}` uses every `exit.action.*` id). Both over-approximate (comments count,
//      a template prefix covers its siblings), so the gate can miss an unused id but never fails a
//      used one. Ids in scripts/copy-unused-baseline.json may stay unused; the list only shrinks.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";
import { applyJosa, resolveJosa } from "../packages/i18n/src/josa.ts";

const HANGUL = /[ㄱ-ㆎ가-힣]/;
const CATALOGS = "packages/i18n/src/catalogs";
const BASELINE = "scripts/copy-unused-baseline.json";
const escape = (s) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");

// The quoted keys of a catalog file's object literal(s).
export const catalogIds = (text) => [...text.matchAll(/^\s*(["'])([^"']+)\1:/gm)].map((m) => m[2]);

// ids: catalog ids; sources: source file texts; baseline: ids allowed to stay unused.
// Returns the problem lines (empty = pass).
export function checkUnused(ids, sources, baseline) {
  const text = sources.join("\n");
  const literals = new Set([...text.matchAll(/(["'`])([a-z][\w-]*(?:\.[\w-]+)+)\1/g)].map((m) => m[2]));
  // interpolations match `.+`, so `enum.${e.type}.${v}` marks every enum.* id used;
  // resolve the toned()/values() type names in lib/labels.ts if unused enum ids start to matter.
  const templates = [...text.matchAll(/`([a-z][\w-]*\.[^`]*?\$\{[^`]*)`/g)].map(
    (m) => new RegExp(`^${m[1].split(/\$\{[^}]*\}/).map(escape).join(".+")}$`),
  );
  const used = (id) => literals.has(id) || templates.some((r) => r.test(id));
  const all = new Set(ids);
  const allowed = new Set(baseline);
  const problems = [];
  for (const id of all) if (!used(id) && !allowed.has(id)) problems.push(`${id}: no source uses this catalog id; delete it from ko/en (or boot.ts), or add it to ${BASELINE} with owner approval`);
  for (const id of allowed) {
    if (!all.has(id)) problems.push(`${BASELINE}: "${id}" is no longer a catalog id; remove it from the baseline`);
    else if (used(id)) problems.push(`${BASELINE}: "${id}" is now used; remove it from the baseline`);
  }
  return problems;
}

// 3. Word gate (docs/design/copy-conventions.md): the verb table and the glossary as banned forms, each naming the
//    canonical word. Korean copy uses TERM_RULES; English catalogs use EN_TERM_RULES (keys and comments are free).
//    Legitimate Korean uses live in scripts/copy-terms-allow.json; stale entries fail, so the list only shrinks.
//    Context-dependent terms (수정 for a dated fact, 이동 for a person, 구성원 in a title) are reviewed, not regexed.
export const TERM_RULES = [
  { rule: "verb.수정", re: /(?<!새로 ?)고[치쳐칠친칩]/, use: "수정 (the recorded act of a dated fact says 변경 or 정정)" },
  { rule: "verb.변경", re: /바[꾸꿔꾼꿨꿉꿀]/, use: "변경 (바뀌다 for a state that changes by itself is fine)" },
  { rule: "verb.이동", re: /옮[기겨긴길깁]/, use: "이동 (a person is not moved: 발령 · 전보 · 전근 · 전적)" },
  { rule: "verb.선택", re: /(?<![가-힣])(고[르른를릅]|골라)/, use: "선택" },
  { rule: "verb.추가", re: /만[들든듭]/, use: "추가 · 등록 · 생성 · 작성 (by object, see the verb table)" },
  { rule: "verb.삭제", re: /(?<![가-힣])지[우워운웁움울]/, use: "삭제 (a field is 비움)" },
  { rule: "verb.제외", re: /(?<![가-힣])(빼[기고면지는려야서]|[뺀뺍뺄](?![가-힣]))/, use: "제외" },
  { rule: "verb.통합", re: /합[치쳐친칩칠]/, use: "통합 (부서) · 병합 (동일인 기록)" },
  { rule: "verb.입력", re: /적으십시오|적어 ?주십시오|적으면|(?<![가-힣]|붙여 )(적기|넣기|넣으십시오|넣으면)(?![가-힣])/, use: "입력" },
  { rule: "verb.label", re: /(?<![가-힣])(정하|끝내|남기|두|잠그|세우|비우|더하|멈추|버리|늘리|되살리|바로잡|올리|보내|담)기(?![가-힣])/, use: "지정·설정 · 종료·완료 · 기록 · 유지 · 잠금 · 수립 · 해제 · 추가 · 중지 · 폐기 · 확장 · 복원 · 정정 · 첨부 · 요청 (verb table)" },
  { rule: "verb.하기", re: /하기(?=\s*($|[·({]))/, use: "a bare noun: 「등록」, not 「등록하기」" },
  { rule: "register.합니다체", re: /(세요|해요|어요|아요|여요|예요|에요|죠|나요|가요|까요|래요|게요)(?=[\s.?)」]*($|·))/, use: "합니다체 (…합니다 · …하십시오 · …합니까?)" },
  { rule: "term.퇴직", re: /퇴사/, use: "퇴직" },
  { rule: "term.인사카드", re: /인사 ?기록 ?카드|인사 ?기록부/, use: "인사카드" },
  { rule: "term.법인", re: /계열사/, use: "법인 (another 법인 of the same tenant)" },
  // 「회사 도메인」 is the sign-in ID's glossary term (decision #33, copy-conventions §8); any other 회사 still fails.
  { rule: "term.회사", re: /회사(?! 도메인)/, use: "법인 · 전체 · 고객 계정 (decision #29) · 회사 도메인 (#33)" },
  { rule: "term.사업장", re: /현장/, use: "사업장" },
  { rule: "term.인사", re: /(?<![A-Za-z])HR(?![A-Za-z])/, use: "인사 · 인사 담당자" },
  // law.go.kr, 2026-10-13: official short titles here are 근로자참여법 and 산재보험법 (agent-rules §13.17).
  { rule: "term.법령명", re: /근기법|(?<![A-Za-z])LSA(?![A-Za-z])/i, use: "근로기준법" },
  { rule: "term.법령명", re: /건보법/, use: "국민건강보험법" },
  { rule: "term.법령명", re: /개보법|(?<![A-Za-z])PIPA(?![A-Za-z])/i, use: "개인정보 보호법" },
  { rule: "term.법령명", re: /근참법/, use: "근로자참여 및 협력증진에 관한 법률" },
  { rule: "term.법령명", re: /고보법/, use: "고용보험법" },
  { rule: "term.법령명", re: /산재법/, use: "산업재해보상보험법" },
  { rule: "term.법령명", re: /(?<![가-힣])고시(?=\s*(?:[§」)]|제?\s*\d+\s*조|기준|준수)|(?:에|의|를|상)(?=\s|$))|(?<![가-힣]\s)(?<![가-힣])고시(?=\s*$)/, use: "개인정보의 안전성 확보조치 기준" },
  { rule: "term.계정", re: /사용자|유저|어드민/, use: "계정 (the sign-in) · 직원 (the person)" },
  { rule: "term.역할", re: /권한 ?그룹|(?<![가-힣])롤(?![가-힣])/, use: "역할" },
  { rule: "term.부여", re: /할당/, use: "부여" },
  { rule: "term.외래어", re: /다운로드|업로드|팝업|테넌트/, use: "내려받기 · 첨부 · 창 · 고객 계정" },
  { rule: "punct.조사", re: /\((을|를|이|가|은|는|으|으로|로|과|와)\)/, use: "{x|을를} josa forms" },
  { rule: "punct.느낌표", re: /!/, use: "no exclamation marks" },
  { rule: "punct.따옴표", re: /'[^'{}\s][^'{}]*'/, use: "「」 for a UI name, “ ” for a value (an ASCII ' is ICU quoting)" },
];

export const EN_TERM_RULES = [
  { rule: "term.법령명", re: /\bPIPA\b/i, use: "Personal Information Protection Act" },
  { rule: "term.법령명", re: /\bLSA\b/i, use: "Labor Standards Act" },
];

// entries: [{ id, where, text }]; allow: [{ id, rule, reason }] where id may end in `*` (a prefix).
// Returns the problem lines (empty = pass).
export function checkTerms(entries, allow, rules = TERM_RULES) {
  const allowed = (id, rule) => allow.find((a) => a.rule === rule && (a.id.endsWith("*") ? id.startsWith(a.id.slice(0, -1)) : a.id === id));
  const used = new Set();
  const problems = [];
  for (const { id, where, text } of entries)
    for (const { rule, re, use } of rules) {
      const m = text.match(re);
      if (!m) continue;
      const a = allowed(id, rule);
      if (a) used.add(a);
      else problems.push(`${where} ${id}: ${rule}: 「${m[0]}」 → ${use}: ${text.slice(0, 80)}`);
    }
  for (const a of allow) if (!used.has(a)) problems.push(`${TERMS_ALLOW}: ${a.id} (${a.rule}) no longer matches; remove it`);
  return problems;
}
const TERMS_ALLOW = "scripts/copy-terms-allow.json";

// 4. Runtime-output check: formatted text must not render written particle alternatives
//    (「이(가)」, 「을(를)」, etc.). josa() and resolveJosa() pick the particle by phonology;
//    rendered copy must never display unresolved fallback particles.
export const RUNTIME_JOSA_RE = /(이\(가\)|가\(이\)|을\(를\)|를\(을\)|은\(는\)|는\(은\)|과\(와\)|와\(과\)|\(으\)로|아\(야\)|야\(아\)|\((?:을|를|이|가|은|는|으|으로|로|과|와)\))/;

export function checkRuntimeOutput(input) {
  const items = Array.isArray(input) ? input : [input];
  const problems = [];
  for (const item of items) {
    const text = typeof item === "string" ? item : (item?.text ?? "");
    const where = typeof item === "object" && item?.where ? `${item.where}: ` : "";
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      const m = trimmed.match(RUNTIME_JOSA_RE);
      if (m) {
        problems.push(`${where}punct.조사: rendered particle alternative 「${m[0]}」 in: ${trimmed.slice(0, 80)}`);
      }
    }
  }
  return problems;
}

// Locale catalogs include every value, even acronym-only copy; mixed-language files keep only Hangul values.
export const copyEntries = (file, text) =>
  text.split("\n").flatMap((line) => {
    const kv = line.match(/^\s*"([^"]+)":\s*("(?:[^"\\]|\\.)*")/);
    if (kv) return /(^|\/)(ko|en)\//.test(file) || HANGUL.test(kv[2]) ? [{ id: kv[1], where: file, text: JSON.parse(kv[2]) }] : [];
    return [...line.matchAll(/"((?:[^"\\]|\\.)*[가-힣](?:[^"\\]|\\.)*)"/g)].map((m) => ({ id: file, where: file, text: m[1] }));
  });

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const isTest = (p) => /\.test\.tsx?$/.test(p);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const problems = [];
  // schema.d.ts is generated from the backend's OpenAPI doc comments (`npm run gen:api`), never rendered.
  for (const p of ["apps/web/src", "packages/api/src"].flatMap((d) => walk(d))) {
    if (!/\.(tsx?|css)$/.test(p) || isTest(p) || p === "packages/api/src/schema.d.ts") continue;
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      if (HANGUL.test(line)) problems.push(`${p}:${i + 1}: literal outside the i18n catalogs: ${line.trim().slice(0, 100)}`);
    });
  }
  // boot.ts and the fragments it spreads (boot-<part>.ts) all ship in the entry.
  const boot = readdirSync(CATALOGS).filter((f) => /^boot(-[\w-]+)?\.ts$/.test(f)).map((f) => `${CATALOGS}/${f}`);
  const ids = [...walk(`${CATALOGS}/ko`), ...boot].flatMap((f) => catalogIds(readFileSync(f, "utf8")));
  const sources = ["apps/web/src", "packages/api/src", "packages/i18n/src"]
    .flatMap((d) => walk(d))
    .filter((p) => /\.tsx?$/.test(p) && !p.endsWith(".d.ts") && !isTest(p) && !p.startsWith(`${CATALOGS}/`))
    .map((p) => readFileSync(p, "utf8"));
  problems.push(...checkUnused(ids, sources, JSON.parse(readFileSync(BASELINE, "utf8")).unused));
  // The gallery is dev-only but still copy; the crash screen's strings ship outside the catalogs by necessity.
  const copyFiles = [...walk(`${CATALOGS}/ko`), ...boot, ...walk("packages/i18n/src").filter((p) => /\/gallery[\w-]*\.ts$/.test(p)), "apps/web/public/chunk-guard.js"];
  const entries = copyFiles.flatMap((f) => copyEntries(f, readFileSync(f, "utf8")));
  problems.push(...checkTerms(entries, JSON.parse(readFileSync(TERMS_ALLOW, "utf8")).allow));
  const enEntries = walk(`${CATALOGS}/en`).flatMap((f) => copyEntries(f, readFileSync(f, "utf8")));
  problems.push(...checkTerms(enEntries, [], EN_TERM_RULES));
  // Exercise catalog messages as well as all particle pairs, even without output paths.
  const message = "{word|이가} {word|을를} {word|은는} {word|과와} {word|으로로} {word|아야} · {word}이(가) {word}을(를) {word}(으)로";
  const runtimeEntries = [{ id: "runtime", text: message }, ...entries.filter(({ text }) => /\{\w+\|/.test(text) || RUNTIME_JOSA_RE.test(text))];
  for (const word of ["HK-0001", "E-000002", "ABC", "abc", "URL", "IBM", "VPN", "Unit", "Hub", "정하늘", "윤바다"]) {
    for (const { id, text } of runtimeEntries) {
      const values = Object.fromEntries([...text.matchAll(/\{(\w+)(?:,\s*(number|plural|selectordinal|date|time)\b)?/g)]
        .map(([, key, numeric]) => [key, numeric ? 2 : word]));
      const rendered = new IntlMessageFormat(applyJosa(text, values), "ko").format(values);
      problems.push(...checkRuntimeOutput({ where: `${id} (${word})`, text: resolveJosa(String(rendered)) }));
    }
  }
  for (const arg of process.argv.slice(2)) {
    try {
      const st = statSync(arg);
      const files = st.isDirectory() ? walk(arg).filter((f) => f.endsWith(".txt")) : [arg];
      for (const f of files) {
        problems.push(...checkRuntimeOutput({ where: f, text: readFileSync(f, "utf8") }));
      }
    } catch (error) {
      problems.push(`${arg}: cannot check runtime output: ${error.message}`);
    }
  }
  if (problems.length) {
    process.stderr.write(`copy: ${problems.length} problem(s):\n${problems.join("\n")}\n`);
    process.exit(1);
  }
}
