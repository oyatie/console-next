<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Engineering guide

How to work in this repository: how a change is proved, how a screen is added, and the conventions the
checks enforce. Read it before a first change. The repository layout is in the [README](../README.md), the
test tiers in [testing/README.md](testing/README.md) and the browser-test strategy in
[testing/e2e.md](testing/e2e.md).

## Set up

- Node: the version in `.node-version`. Run `npm ci` at the root.
- Rust: the toolchain in `rust-toolchain.toml`. The backend workspace is `backend/`.
- `npm run check` needs two tools that `npm ci` does not install: `gitleaks` on `PATH` (the secret scan and
  the hygiene test run it) and the Playwright browsers (`npx playwright install chromium firefox`; unit
  tests and the state suite launch Chromium, the cross-browser runs use Firefox).
- The checks that compare a branch with its base read the local branch `dev`. Keep it current, or name the
  ref that holds the base: `QUALITY_BASE=<remote>/dev npm run check`.
- Database-backed backend tests need the Postgres topology that `.github/workflows/db-tests.yml` creates.
  Reproduce that job's setup locally rather than inventing one.

## A change, start to finish

1. Branch from `dev`. To pick up newer work, merge `dev` into the branch.
2. Write the test that fails without the change, then the change.
3. Run the checks for what you touched (below) before pushing.
4. Open a pull request against `dev`. Its description says what changes for a user or caller, why, and how
   it was checked, in plain words.
5. Required checks run on the pull request and again in the merge queue.

Green checks leave two kinds of test unrun. Database-backed backend tests run on pushes to `dev` and
nightly; `.github/workflows/db-tests.yml` runs on a pull request only when the pull request changes that
workflow or the test tooling it names. Of the journey specs, a pull request runs one
(`e2e/performance/home-inbox.spec.ts`) and the merge queue adds three (`e2e/first-run-solo.spec.ts`,
`e2e/authz/write-refusals.spec.ts`, `e2e/error-beacon.spec.ts`); the rest run nightly
(`.github/workflows/e2e-live.yml`). When you add or change a database test or a journey spec, run it
locally before pushing (see the table), or its first failure shows on `dev` after the merge.

A check that keeps a baseline (bundle size, standing text, design-system usage and others) lets the baseline
only go down. When `dev` lowers one, a branch cut earlier fails that check until it merges `dev`.

## Proving a change

| Touched | Run |
|---|---|
| Web client | `npm run check` (contract, types, lint, unit tests, build, secret scan, licence headers) |
| A screen | also its state and mock specs: `npm run e2e:states -- e2e/states/<area>.spec.ts e2e/mock/<screen>.spec.ts`, or by test title, `npm run e2e:states -- --grep '<screen key>: '` (see below). Without a filter the command runs every mock and state spec, far more than its ten-minute limit allows on one machine; CI runs them in shards |
| A journey | the spec you changed, against the [local stack](../deploy/dev/README.md) (Docker Compose and a backend built with `full,e2e-test-support`): `npx playwright test e2e/<spec>.spec.ts --project=parallel` |
| Backend code | in `backend/`: `cargo fmt --all --check`, `cargo clippy --locked --all-targets -- -D warnings` for the touched packages, and their tests |
| Database-backed tests | with `DATABASE_URL` set to the database from Set up: `node scripts/backend-tests.mjs --db`. It needs `cargo-nextest` and runs the whole database selection, which CI splits into shards; see [rust-testing.md](architecture/rust-testing.md) |
| A `sqlx::query!` macro, or a column one reads | in `backend/`: `cargo sqlx prepare --workspace` (from `sqlx-cli`) with `DATABASE_URL` pointing at a database that has every migration applied, then commit `backend/.sqlx`. CI compiles with `SQLX_OFFLINE=true`, so a query missing from the cache fails the build there even when it compiles locally against a live database. See [the database crate README](../backend/crates/platform/db/README.md) |
| Backend structure | each gate under `backend/ci/gates`: `cargo run -q --locked -p console-gate-<name>` |
| The API contract | the steps in "The API contract" |

A test that fails only under machine load is rerun alone before it is called broken. A test that fails
again is fixed, not rerun.

## The API contract

`backend/openapi/openapi.yaml`, `backend/openapi/ops.yaml` and these files in `packages/api/src` are
generated: `schema.d.ts`, `ops-schema.d.ts`, `pay-group-schema.ts`, `job-title-schema.ts` and
`otp-format.ts`. Never edit them.

1. Edit the fragments of the owning crate: `backend/crates/<domain>/rest/openapi/`.
2. Register a new path or schema file by hand; files are not discovered. Add an `include_str!` entry to
   `backend/crates/contracts/src/gen_registry.rs`, the list the generator composes from, and the same
   entry to the crate's `rest/src/openapi.rs`. Ops fragments are registered in
   `backend/crates/contracts/src/ops_registry.rs`. An unregistered file changes nothing and the generator
   still reports success. The registry's "do not edit" header names `backend/openapi/split_openapi.py`,
   which rewrites the fragment directories from the composed contract; do not run it to register a file.
3. Regenerate the contract: `cargo run --locked --manifest-path backend/Cargo.toml -p console-contracts --bin console-openapi-gen`.
4. Commit the backend change.
5. Regenerate the client types: `npm run gen:api`. It reads the committed contract, which is why step 4
   comes first.

New optional request fields and new optional response fields are compatible. A new required request field
is not: the `api-compat` check compares the contract with the released one, not with `dev`, and refuses it,
because released clients do not send the field. A response enum that may gain values is declared with
`x-extensible-enum`, because adding a value to a closed enum breaks released clients.

## Database migrations

- Add a new file under `backend/crates/platform/db/migrations/`, named `YYYYMMDDHHMMSS[mmm]_name.sql`;
  never edit one that has merged. Its header declares `-- migration-class: expand` or
  `-- migration-class: contract — <reason>`.
- The name is a UTC timestamp later than the newest migration on `dev`, and not in the future. CI compares
  against the tip of `dev`, so when `dev` gains a newer migration first, rename yours after merging `dev`.
- The migration-safety gate checks that order only when `MIGRATION_BASE` names the base. CI sets it; a
  plain local run skips the check and still passes. After fetching, run it in `backend/` as
  `MIGRATION_BASE=<remote>/dev cargo run -q --locked -p console-gate-migration-safety`.
- A table that holds tenant data has row-level security, forced. The gates under `backend/ci/gates` check
  this, tenant isolation, personal-data classification and migration safety; run them after writing one.

## Adding or changing a screen

A screen is proved in five steps, each cheaper than the next.

1. **Compose it from the design system.** Components come from `apps/web/src/ui`, values from
   `@console/tokens`. The design-system check refuses raw colours and one-off look-alikes.
2. **Show every state in the gallery.** Put a `<name>.gallery.tsx` beside the component. It default-exports
   a demo that renders the component with fixture data and no network. Entries are discovered
   automatically and served at `/_gallery` in development and test builds.
3. **Add it to the state matrix.** Each area keeps a typed list of screen records in
   `e2e/states/<area>.ts`: key, route, primary read, the states the screen must handle, its screen-registry
   id and the journey spec that proves it against the real server. The spec beside it,
   `e2e/states/<area>.spec.ts`, walks every state at 1440 and 390 pixels wide and ends with `fits` and
   `expectAxe`. `e2e/states/registry.ts` and `screens.spec.ts` are that pair for home, people and the org
   chart, with the shared states: empty, loading, failed, refused, populated, long text and large data.
   `screens.spec.ts` asserts those three screens by key, so a new screen gets its own list and spec, not a
   row there; add its record type to `Screen` in `registry.ts` when the spec passes it to `mockScreen`. See
   [e2e/mock/README.md](../e2e/mock/README.md).
4. **Drive the behaviour with mock specs.** A spec under `e2e/mock` that loads a screen calls `mockScreen`,
   which answers the shell and the screen's supporting reads; the spec adds its own replies with
   `mockRoute`. Any other request under `/api` gets a 501 and is recorded in the `unexpected` list that
   `mockScreen` returns. End each test by asserting that list is empty: that assertion is what stops a
   screen quietly depending on an endpoint the spec does not know about. A new supporting read goes into
   `e2e/mock/screen.ts` or the area's `e2e/mock/<area>.ts`.
5. **Then the journey.** A change that finishes a user task extends the journey specs under `e2e/`, which
   run against the real server; the table above gives the local command.

Also required for a screen:

- **Copy.** Text lives in `packages/i18n`, never in a component. Every message id is defined in the `en`
  catalog, the source, and the `ko` catalog must define every id.
- **Standing text.** Each screen has a pinned count of always-visible text blocks, and a pin only goes
  down. A new screen adds its total to `scripts/standing-text-baseline.json` and its six category counts
  (`FACT`, `REFUSAL`, `EMPTY`, `LEGAL`, `RECEIPT`, `EXPLANATION`) to
  `scripts/standing-text-new-screens.json`; one file under `scripts/standing-text.d/` may carry both
  instead. The counts must sum to the pin, and `EXPLANATION` must be 0: a new screen ships no explanatory
  text.
- **Bundle budget.** A new route declares its page type in `scripts/bundle-budget.json`.
- **Both widths, both themes, both browsers.** 1440 and 390 pixels, light and dark, Chromium and Firefox.
  The state suite runs in Chromium unless `E2E_XBROWSER=1` selects Firefox; CI runs it in Chromium on pull
  requests and in Firefox nightly.
- **Honest states.** Loading, empty, failed and refused each say what happened and what to do next. No
  permission never looks like no data.

## Conventions

- **English** in code, comments, documentation, API text, commit messages and pull requests. Korean
  appears as interface copy in the `ko` catalog, in the server's frozen error-message table, in legal
  documents, in statutory data and in test data.
- **Text stands on its own.** Comments, API descriptions, test names, commit messages and pull requests
  state the rule or reason itself. They do not cite ticket numbers, decision numbers or internal labels,
  which mean nothing to a later reader.
- **Comments say why**, not what the code does.
- **Commit subjects** follow `type: what changes` or `type(scope): what changes`, with `feat`, `fix`,
  `perf`, `test`, `docs`, `refactor`, `build`, `ci`, `style`, `revert` or `chore`. Git's default
  `Revert "..."` subject is also accepted. Every non-merge commit a pull request adds is checked, so reword
  `wip` and `fixup!` commits before pushing. The body says why.
- **Licence header** on the first line of every new source file, in the comment form of its language.
- **Synthetic data only.** No real person, company or identifier in code, tests, fixtures or screenshots.
- **Server messages** carry a stable code and an English message at their source. A new code gets catalog
  copy, defined in `en` and translated in `ko`, as `common.failed.code.<code>` or as the screen's own
  refusal ids, and the interface shows that copy first. For a failed command whose code has no catalog
  copy, the interface shows the server's message, which the server rewrites into Korean for
  `Accept-Language: ko` from a frozen table (`backend/crates/platform/request-context/src/error_i18n`).
  Never reword or drop an English key in that table. A code with neither shows a Korean reader only a
  generic sentence, and nothing checks for that.
- **Refusals are tested.** Every way the server can refuse a request has a test that asserts the status,
  the code, and that nothing was written.
