<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Engineering guide

How to work in this repository: how a change is proved, how a screen is added, and the conventions the
checks enforce. Read it before a first change. The repository layout is in the [README](../README.md), the
test tiers in [testing/README.md](testing/README.md) and the browser-test strategy in
[testing/e2e.md](testing/e2e.md).

## Set up

- Node: the version in `.node-version`. Run `npm ci` at the root.
- Rust: the toolchain in `rust-toolchain.toml`. The backend workspace is `backend/`.
- Database-backed backend tests need the Postgres topology that `.github/workflows/db-tests.yml` creates.
  Reproduce that job's setup locally rather than inventing one.

## A change, start to finish

1. Branch from `dev`. To pick up newer work, merge `dev` into the branch.
2. Write the test that fails without the change, then the change.
3. Run the checks for what you touched (below) before pushing.
4. Open a pull request against `dev`. Its description says what changes for a user or caller, why, and how
   it was checked, in plain words.
5. Required checks run on the pull request and again in the merge queue.

A check that keeps a baseline (bundle size, standing text, design-system usage and others) lets the baseline
only go down. When `dev` lowers one, a branch cut earlier fails that check until it merges `dev`.

## Proving a change

| Touched | Run |
|---|---|
| Web client | `npm run check` (contract, types, lint, unit tests, build, secret scan, licence headers) |
| A screen | also `npm run e2e:states` for its states, and the mock specs that drive it (see below) |
| Backend code | in `backend/`: `cargo fmt --all --check`, `cargo clippy --locked --all-targets -- -D warnings` for the touched packages, and their tests |
| Backend structure | each gate under `backend/ci/gates`: `cargo run -q --locked -p console-gate-<name>` |
| The API contract | the steps in "The API contract" |

A test that fails only under machine load is rerun alone before it is called broken. A test that fails
again is fixed, not rerun.

## The API contract

`backend/openapi/openapi.yaml` and the client types in `packages/api` are generated. Never edit them.

1. Edit the fragments of the owning crate: `backend/crates/<domain>/rest/openapi/`.
2. Regenerate the contract: `cargo run --locked --manifest-path backend/Cargo.toml -p console-contracts --bin console-openapi-gen`.
3. Commit the backend change.
4. Regenerate the client types: `npm run gen:api`. It reads the committed contract, which is why step 3
   comes first.

New request fields and new optional response fields are compatible. A response enum that may gain values
is declared with `x-extensible-enum`, because adding a value to a closed enum breaks released clients.

## Database migrations

- Add a new file; never edit one that has merged.
- Name it with a timestamp later than the newest migration on `dev` at the time of the commit, and not in
  the future.
- A table that holds tenant data has row-level security, forced. The gates under `backend/ci/gates` check
  this, tenant isolation, personal-data classification and migration safety; run them after writing one.

## Adding or changing a screen

A screen is proved in three layers, each cheaper than the next.

1. **Compose it from the design system.** Components come from `apps/web/src/ui`, values from
   `@console/tokens`. The design-system check refuses raw colours and one-off look-alikes.
2. **Show every state in the gallery.** Put a `<name>.gallery.tsx` beside the component. It default-exports
   a demo that renders the component with fixture data and no network. Entries are discovered
   automatically and served at `/_gallery` in development and test builds.
3. **Add it to the state matrix.** `e2e/states/registry.ts` lists screens with the states each must
   handle: empty, loading, failed, refused, populated, long text and large data. `e2e/states/screens.spec.ts`
   walks every state at 1440 and 390 pixels wide and runs the accessibility checks. `npm run e2e:states`
   runs it.
4. **Drive the behaviour with mock specs.** Specs under `e2e/mock` use `mockScreen`, which answers only the
   requests the spec declares and fails the test on any other, so a screen cannot quietly depend on an
   endpoint the spec does not know about.
5. **Then the journey.** A change that finishes a user task extends the journey specs under `e2e/`, which
   run against the real server.

Also required for a screen:

- **Copy.** Text lives in `packages/i18n`, never in a component. Every message id exists in both the `en`
  and `ko` catalogs.
- **Standing text.** Each screen has a budget of always-visible explanatory text. A new screen registers
  its counts in `scripts/standing-text-new-screens.json`.
- **Bundle budget.** A new route declares its page type in `scripts/bundle-budget.json`.
- **Both widths, both themes, both browsers.** 1440 and 390 pixels, light and dark, Chromium and Firefox.
- **Honest states.** Loading, empty, failed and refused each say what happened and what to do next. No
  permission never looks like no data.

## Conventions

- **English** in code, comments, documentation, API text, commit messages and pull requests. Korean
  appears as interface copy in the `ko` catalog, in legal documents, in statutory data and in test data.
- **Text stands on its own.** Comments, API descriptions, test names, commit messages and pull requests
  state the rule or reason itself. They do not cite ticket numbers, decision numbers or internal labels,
  which mean nothing to a later reader.
- **Comments say why**, not what the code does.
- **Commit subjects** follow `type(scope): what changes`, with `feat`, `fix`, `perf`, `test`, `docs`,
  `refactor`, `build` or `chore`. The body says why.
- **Licence header** on the first line of every new source file, in the comment form of its language.
- **Synthetic data only.** No real person, company or identifier in code, tests, fixtures or screenshots.
- **Server messages** carry a stable code and an English message. The interface shows text from its
  catalogs, keyed by the code.
- **Refusals are tested.** Every way the server can refuse a request has a test that asserts the status,
  the code, and that nothing was written.
