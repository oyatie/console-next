# Copy guide (catalog rules)

Every user-facing string lives in the catalogs, one file per id prefix. **English is the source**:
`src/catalogs/en/<ns>.ts` (merged by `en.ts`) defines every id. Each locale translates those ids:
`ko/<ns>.ts` (merged by `ko.ts`) is typed `Record<keyof typeof en…, string>`, so a missing Korean id
fails `npm run typecheck`; a future locale may be partial and falls back to English. `t()` looks up the
current locale (Korean by default). Sign-in, shell and shared-state copy (ids `app.`, `auth.`,
`common.`, `shell.`) lives in `src/catalogs/boot.ts` (every locale) instead: it ships in the entry,
while each locale's screen catalog loads with the first screen.
A new string: add the id with its English text to `en/<ns>.ts`, then its Korean to `ko/<ns>.ts`.
Components never contain literal text; `npm run lint` fails on Hangul outside the catalogs.

The same lint step and the dependency-free `node scripts/check-hangul.mjs` gate ratchet
Hangul across repository text files. Counts include decoded Unicode and CSS escapes, numeric HTML
entities, and static `String.fromCharCode` / `String.fromCodePoint` calls, including Jamo,
per category: Rust source, Rust test files, E2E, web test files, scripts, migrations,
docs, and other text. Inline Rust test modules remain in the source-file category.
Tracked and non-ignored new UTF-8 files are checked; binary files, locale catalog source,
and the generated API declaration `packages/api/src/schema.d.ts` are excluded.
Web product source keeps its zero-debt rule; only `.test.ts` and `.test.tsx` files are exempt.
Pre-existing escaped product text is baselined; new escaped product text is refused.

Each category must stay at or below its count in `git merge-base HEAD origin/dev`.
`QUALITY_BASE` overrides the target; local checkouts prefer `public/dev` when available.
Reductions automatically lower the ceiling on merge; no stored counts need updating.
Run `node scripts/check-hangul.mjs --report` (or `node scripts/check-copy.mjs --report`)
to print candidate and merge-base counts.

`scripts/copy-hangul-baseline.json` stores only named exceptions, sorted by name.
Each entry needs an exact path, regex pattern, and reason. Official reference labels
in refdata or migrations also require a `source` URL identifying the statute or publishing
agency (or the official translation dataset). Publishers are restricted to law.go.kr,
nts.go.kr, nps.or.kr, nhis.or.kr, comwel.or.kr, ei.go.kr, kosis.kr and juso.go.kr.
Two existing datasets also need their official publishers: [MOIS administrative codes](https://www.code.go.kr/stdcode/regCodeL.do)
use code.go.kr; the country migration cites [Unicode CLDR](https://github.com/unicode-org/cldr-json/tree/48.0.0/cldr-json/cldr-localenames-full/main),
so only that GitHub repository is accepted. Add a cited publisher reason here before extending the list.
Test-like filenames under migrations or refdata still require an official source.
Synthetic Korean-input test fixtures may be named separately outside `e2e/` and `apps/web/`;
UI tests use catalog lookups and cannot declare exceptions. Whole-line regexes are refused;
a whole-line match remains debt. Matched fragments count as `allowed.<name>`; comments
(including `#` comments) and unmatched fragments remain debt. Existing definitions cannot
be widened, and unused entries must be removed. New test exceptions can only reclassify
existing fragments measured at the merge base; they cannot approve new test text. Synthetic
exception counts cannot grow, including in new, renamed or copied files; a file with a test exception cannot gain Hangul lines.
Sourced `official-*` entries for `.sql`, `.tsv`, `.csv` or `.json` reference data under refdata or migrations may grow to
cover additions and refreshes. This allowance excludes test files. Every added Hangul line
must be covered; comments and unmatched fragments remain subject to the category ceiling.
A path-only update of an official reference entry is allowed for a Git-detected rename or copy.
Every added or changed definition and each exception count delta is printed in the gate
output and CI step summary, including changes the gate refuses. Ordinary translated UI
assertions, comments, and test names remain debt.

## Ids
`<area>.<screen or component>.<element>` — e.g. `org.unit.action.createChild`, `people.exit.confirm`.
Enums: `enum.<type>.<VALUE>` — e.g. `enum.orgChangeStatus.IN_APPROVAL`.

## Voice: active, entity + action
- **Buttons = verb + object, naming the outcome.** "부서 신설", "직원 등록", "대표전화 수정",
  "초안 저장". Never bare "확인", "처리", "기안 작성". A destructive or irreversible action names what
  it ends: "퇴직 처리", "계정 비활성화".
- **Events = who did what to which entity, past tense.** "{actor}님이 {role} 결재를 승인했습니다",
  "{actor}님이 조직 변경을 상신했습니다". The actor is the grammatical subject.
- **Status = state noun**, not an instruction: "결재 중", "시행됨", "반려됨", "첫 로그인 대기".
- **Consequence before commitment.** Dialogs say what will happen, to what, and whether it can be
  undone: "{name|을를} {date}자로 {unit|으로로} 전보합니다. 되돌릴 수 없고 감사 기록에 남습니다."
- **Empty state = what is missing + why it matters + the next action (as a button).**
- **Error text is catalog copy keyed by the server's code** (`common.failed.code.<code>`, or the screen's
  own refusal ids). The server's localized message is only the fallback for a code with no catalog copy.
- **One verb per action, everywhere:** the verb table and glossary of `docs/design/copy-conventions.md`
  (수정 · 변경 · 정정 · 추가 · 등록 · 신설 · 삭제 · 제외 · 이동 · 발령 · 선택 · 입력 …). Buttons are object +
  bare action noun (「대표전화 수정」), never 「~하기」 or a native paraphrase (「고치기」, 「옮기기」, 「고르기」).
  `npm run lint` fails on the banned forms (scripts/check-copy.mjs rule 3).
  `scripts/copy-terms-allow.json` only shrinks; correct the rule's context for legitimate uses.
  After changing a baselined string or merging catalog changes, regenerate
  `scripts/copy-maturity-baseline.json` with `node scripts/check-copy.mjs --write-baseline`;
  never edit the generated baseline by hand. Stale entries fail the gate, and regeneration
  cannot allow new debt.
- 합니다체 for sentences, noun phrases for labels, no trailing periods on labels/buttons.
- Korean particles after variables use `{name|을를}`, `{x|이가}`, `{x|으로로}` — never "을(를)".
- Numbers, dates, money: ICU (`{count, number}`, `{count, plural, other {#명}}`) or the shared
  formatters — never string concatenation.
