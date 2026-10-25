# Copy guide (catalog rules)

Every user-facing string lives in `src/catalogs/ko/<ns>.ts` (source, one file per id prefix, merged by
`ko.ts`) and is translated per locale (`en/<ns>.ts`, merged by `en.ts`). Sign-in, shell and
shared-state copy (ids `app.`, `auth.`, `common.`, `shell.`) lives in `src/catalogs/boot.ts` (both
locales) instead: it ships in the entry, while each locale's screen catalog loads with the first screen.
Components never contain literal text; `npm run lint` fails on Hangul outside the catalogs.

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
- **Errors come from the server** (localized via Accept-Language); the UI only adds where to act.
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
