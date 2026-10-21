# Coverage-guided fuzzing

libFuzzer (through cargo-fuzz) on the parsers that take untrusted input on the MVP routes. This
directory is its own cargo root on the nightly in `rust-toolchain.toml`; the workspace stays on
stable and never builds it.

```sh
cargo install cargo-fuzz          # once
backend/fuzz/run.sh               # every target, 600 s each (FUZZ_SECONDS), 2 fork workers (FUZZ_JOBS)
FUZZ_SECONDS=60 backend/fuzz/run.sh kr-ids
python3 backend/fuzz/seed.py      # rewrite the committed seeds after changing an input format
```

| Target | Input | Invariants beyond "never panics" |
|---|---|---|
| `xlsx-read` | an uploaded `.xlsx` (zip guards, calamine cell reader, header detection) | cells read never exceed the cap |
| `import-cells` | one cell's text through every import normaliser and `Rrn::parse` | what the vault accepts the PII scrub catches; mask and `Debug` hide the back digits; column letters round-trip |
| `import-mapping` | the preview/apply mapping body + a sheet | an operator mapping never gives two columns one target |
| `kr-ids` | 사업자등록번호, 종사업장, 법인등록번호, 사업장관리번호, phone, e-mail | a parsed value is canonical (stored and display forms parse back to it) |
| `json-patch` | a field PATCH or command facts + the current record | nothing is accepted with every path unreadable; `json_eq` symmetric |
| `attendance-entry` | one policy byte followed by UTF-8 entry text | ordered, positive spans inside the 48-hour horizon; confirmation bypasses only the effective threshold |
| `entity-bodies` | 법인 / 사업장 / 사업자등록 / correction / grant-basis bodies, uploads, codes | refusal codes are stable snake_case; a 법인 name is 1–200 characters |

`xlsx-read` mirrors `app/src/hr/workbook_read.rs` (private to console-app) on top of the real
domain guards and vendored calamine; keep the loop in step with that file.

Seeds are synthetic (no real PII). `xlsx-read` also reads `docs/reference/*.xlsx` as an extra,
uncommitted corpus. Only `corpus/*/seed-*` is committed; the rest is libFuzzer's working set.

## Findings

A finding becomes a regression test in the owning crate, named `regression_fz<n>_…`. While the
product fix is open the test is `#[ignore]`d (it fails on the current tree:
`cargo test -- --include-ignored`) and the target skips the input class (`known` /
`FZ-n` comments) so a run explores past it. Fix the product, drop both, keep the test.

| Id | Found by | What | Test | State |
|---|---|---|---|---|
| FZ-1 | `import-cells` | `Rrn::parse` panics on 13 bytes with a multi-byte character across byte 6 (`split_at(6)`); an RRN-column cell like `12345가67890` panics the import preview | `hr/domain/tests/fuzz_regressions.rs` | open, IMPORT |
| FZ-2 | `import-cells` | (withdrawn: the target's own invariant was wrong; `is_rrn_value` is a superset of `contains_rrn_shaped` by design) | — | — |
| FZ-3 | `kr-ids` | `PhoneE164` stores `00 82 10-…` / `+82 0…` as `+820…`, which re-parses to another number | `kernel/core/tests/fuzz_regressions.rs` | open, kernel |
| FZ-4 | `import-cells` | `Rrn::parse` accepts a hyphen anywhere and trailing control whitespace; `is_rrn_value` (the PII scrub) does not | `hr/domain/tests/fuzz_regressions.rs` | open, IMPORT |
| FZ-5 | `xlsx-read` | a reversed `<dimension ref="B2:A1"/>` underflows in calamine `get_dimension` (panic wherever overflow checks are on) | `app/src/hr/workbook_read_tests.rs`, input `regressions/fz5-reversed-dimension.xlsx` | open, IMPORT (vendored calamine) |

| FZ-6 | `attendance-entry` | `3~4/59` creates an empty span before the break | `attendance/domain/src/records/grammar_tests.rs` | fixed, CX-att-s2-repair |
| FZ-7 | `attendance-entry` | `9-18,24-0+` creates an empty midnight span | `attendance/domain/src/records/grammar_tests.rs` | fixed, CX-att-s2-repair |

Not fuzzed yet: the attendance CSV parser (`parse_csv_rows`, private in `app/src/hr.rs`; needs a
`pub` seam), the RRN keyed hash itself (`app/src/hr/rrn_vault.rs`, private; its input `Rrn` is
fuzzed).
