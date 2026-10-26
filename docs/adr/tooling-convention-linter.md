<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Linter convention: preserve native coverage and evaluate ESLint for missing rules

Date: 2026-10-26. Status: **superseded** — the owner ruled on 2026-10-26 to adopt full ESLint and drop oxlint (tracked as LINT-ESLINT); the analysis below is the pre-ruling record. Decision owner: Jason Lee. Scope: web build/tooling and test linting; no runtime dependency or access-policy change. This ADR adds no package and changes no active lint configuration.

## Decision

Choose **oxlint plus narrowly scoped ESLint flat configuration** as the preferred candidate for a later approved implementation. Keep the current oxlint rules and overrides as their existing rule authority. Evaluate ESLint with `typescript-eslint`, first-party `eslint-plugin-react-hooks`, and `eslint-plugin-playwright` for missing or insufficiently enforced rules. Keep native oxlint JSX accessibility coverage and the existing Stylelint token rules. Do not add the separate JSX accessibility plugin merely to duplicate that coverage.

The implementation remains conditional on the owner's package ruling, architecture entry, planted-case parity and measured PR-tier time. Current oxlint also remains NEEDS-OWNER: keeping an installed binary operational is not retroactive approval. Every proposed package is NEEDS-OWNER because these are competing choices. No delegated STANDARD approval is claimed. See the [dependency register](../quality/dependency-register.md) and [frontend architecture record](../architecture/frontend-module-map.md).

A full ESLint replacement can supersede this candidate only when it preserves every native rule, option, exclusion and ring override and does not slow the PR tier. Avoid a permanent pair of linters checking the same rule: each adopted rule must have one recorded authority. If that cannot be achieved within the time budget, return the coverage/time tradeoff to the owner; do not silently drop rules or move correctness checks out of PRs.

## Evidence and actual gaps

[React's editor guidance](https://react.dev/learn/editor-setup) recommends ESLint and its hook rules. The [first-party hooks reference](https://react.dev/reference/eslint-plugin-react-hooks) covers compiler-related invariants as well as hook ordering and dependencies. This supports evaluating first-party behavior rather than assuming a similarly named native rule is equivalent.

[ESLint documents flat configuration](https://eslint.org/docs/latest/use/configure/configuration-files). [typescript-eslint documents typed linting with project service](https://typescript-eslint.io/getting-started/typed-linting/). [Playwright recommends resilient, user-facing tests](https://playwright.dev/docs/best-practices); the [Playwright ESLint plugin's rule catalogue](https://github.com/mskelton/eslint-plugin-playwright#rules) supplies concrete rules. The plugin is community-maintained; the Playwright base approval does not approve it.

Oxlint already implements substantial React, TypeScript, import and accessibility coverage. Its [rule catalogue](https://oxc.rs/docs/guide/usage/linter/rules.html) and our installed binary are stronger evidence than a blanket claim that it lacks hooks or accessibility. Its [type-aware path](https://oxc.rs/docs/guide/usage/linter/type-aware.html) requires the additional `oxlint-tsgolint` dependency and explicit enablement, while its [JS plugin API is alpha](https://oxc.rs/docs/guide/usage/linter/js-plugins.html). Neither path is free of new dependencies or compatibility work.

The [generated installed-config snapshot](../quality/linter-evidence.json) records oxlint 1.86.0, all **221 effective rule entries**, all **14 ordered overrides**, a configuration hash, the exact lint command and three executable probes. The count includes disabled and type-dependent entries: configuration presence is not evidence that a rule runs. `package.json` runs oxlint over `apps packages`, without `--type-aware`; `oxlint.json` does not enable type awareness, and this command does not scan `e2e/`.

| Probe under the installed configuration | Observed result | Required target behavior |
| --- | --- | --- |
| Call an async function and discard its promise | Exit 0, no diagnostic | `@typescript-eslint/no-floating-promises` refuses it |
| Call `page.waitForTimeout` | Exit 0, no diagnostic | `playwright/no-wait-for-timeout` refuses it in browser tests |
| Call `useState` conditionally | `react/hooks` warning, exit 0 | First-party `react-hooks/rules-of-hooks` refuses it |

These probes document gaps; they do not alter production lint severities in this round. Existing E2E/domain policies stay in place until the responsible lane proves a replacement. The E2E-practices files named in the lane exclusions are absent from this public base and were not created or edited here.

## Alternatives

| Choice | Coverage and migration cost | PR time | Maintenance and verdict |
| --- | --- | --- | --- |
| ESLint flat config + typed TypeScript + hooks + JSX accessibility + Playwright | Conventional ecosystem composition. Those packages alone do **not** replace existing `react/*`, `import/*`, refresh and `oxc/*` contracts; full replacement needs additional plugins or retained checks and exact rule mapping. | Not measured; no candidate package installed. Typed linting creates a TypeScript program. | One engine eventually, but more plugins and migration work; JSX/react/import candidates also fail the current release-age criterion. Do not swap in this round. |
| oxlint only | Preserves current native coverage and fast traversal. Current invocation misses typed execution and E2E coverage; hook-order warnings do not fail. Adding its Go-backed typed helper and JS plugins still requires approval and parity tests. | Current lint measured below; augmented mode unmeasured. | Fewest active tools, but incomplete required behavior today. Retain operationally, not as a declaration of maturity. |
| oxlint + ESLint for missing rules | Preserves every existing native check while adding typed promise checks, first-party hooks and Playwright rules. Avoids adding separate React/import/accessibility plugins for already-covered native rules. | Current oxlint tier measured; hybrid unmeasured and not eligible to activate yet. | Preferred candidate with explicit rule ownership; two engines and overlapping preset rules require disciplined scoping. |

Biome is another comparable linter, so adoption alone cannot satisfy the no-close-alternative STANDARD criterion. Prettier formats code; it does not replace semantic, accessibility, ring or browser-test checks. Neither is proposed for addition here.

## Required rule ownership and preservation mapping

The effective snapshot is the complete rule list and options baseline; the table below explains its ownership groups. Keep every current error, warning and explicit `off` setting until a separate behavior change is reviewed. Replacement parity includes diagnostics, severity, paths, generated exclusions and override order, not just matching rule names.

| Current contract | Hybrid owner / full ESLint mapping |
| --- | --- |
| Core correctness/suspicious and TypeScript syntax rules in the snapshot | Keep oxlint; full replacement must map each entry to ESLint core or `@typescript-eslint/*`, with planted cases for differing semantics. |
| `no-console`, `max-lines` (300, skip blanks/comments) | Keep oxlint; ESLint same-name rules with identical options if ever replaced. Keep the shrink-only per-file policy in `check-source`. |
| `no-restricted-imports`, `no-restricted-globals`, all ring overrides | Keep oxlint. ESLint core rules can express these restrictions, but every path group and exception must be copied in the same order. |
| `import/no-cycle`, `import/no-unassigned-import` with CSS exception | Keep oxlint. Full replacement requires separately approved import rules with resolver and cycle parity; the proposed minimum ESLint stack does not supply them. |
| `react/forbid-dom-props` (`style`), `react/forbid-elements`, `react/jsx-no-literals`, other native React entries | Keep oxlint. Full replacement needs React rules and identical options, including the current allowed punctuation and house-control policy. |
| `react/only-export-components` and route/main/gallery exceptions | Keep oxlint. Full replacement would require separately approved `react-refresh/only-export-components`, including gallery `order` exports. |
| `oxc/no-barrel-file` with package-entry exceptions, other `oxc/*` entries | Keep oxlint. No proven one-to-one mapping is asserted; these prevent an unconditional ESLint-only swap. |
| Native `jsx-a11y` entries; `prefer-tag-over-role` explicitly off | Keep oxlint. Full replacement needs JSX accessibility rule/option parity; no duplicate plugin in the hybrid. Browser accessibility assertions remain necessary. |
| Current hooks/compiler rules, including dependency arrays | First-party hooks plugin is the proposed authority after explicit parity review; disable only equivalent native entries in that same reviewed change. Unmapped native rules remain. Hook ordering must become an error. |
| CSS color/spacing/typography token enforcement | Existing Stylelint + strict-value plugin; neither JavaScript option replaces them. Their dependency approval remains separate. |
| OpenAPI drift, Korean glossary, entity presentation, standing-copy budgets, Cedar and clean-ring contracts | Existing domain gates; generic linter plugins do not replace these contracts. |

The 14 override groups cover package index barrels, routes, lib/main command access, feature domain/pure TS, slice-root/API TS, UI primitives, neutral packages, the browser API adapter, view controls/command imports, main exports, gallery exports, the org unit picker, named legacy screen exports, and shell copy punctuation. Preserve `packages/api/src/schema.d.ts` exclusion and all these scopes exactly.

Required additions, after ruling:

- Typed TS: `no-floating-promises`, `no-misused-promises`, `await-thenable`; the `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return` family for typed application boundaries. Use existing project configurations through project service; do not hide parse failures behind broad default-project fallbacks. Keep runtime input validation.
- First-party hooks: `rules-of-hooks`, `exhaustive-deps`, `component-hook-factories`, `config`, `error-boundaries`, `gating`, `globals`, `immutability`, `incompatible-library`, `preserve-manual-memoization`, `purity`, `refs`, `set-state-in-effect`, `set-state-in-render`, `static-components`, `unsupported-syntax`, `use-memo`. Compiler-only diagnostics apply to relevant React sources; document any nonapplicable rule instead of blanket suppression.
- Browser tests: `missing-playwright-await`, `no-wait-for-timeout`, `no-networkidle`, `no-force-option`, `no-page-pause`, `no-focused-test`, `no-skipped-test`, `no-element-handle`, `no-eval`, `prefer-web-first-assertions`, `valid-expect`, `expect-expect`. Apply Playwright rules to E2E tests and browser helpers/tests, not plain unit tests. Preserve any reviewed fixture-specific exceptions through the responsible lane's policy.

## Adoption, licence and maintenance

The [candidate metadata snapshot](../quality/linter-candidates.json) contains primary npm registry responses, maintainers, latest stable release dates and download windows. Download counts describe ecosystem use; they are not unique users, safety proof or approval. All candidates below have registry MIT declarations; exact selected pins and transitive licences must still be checked before addition.

| Candidate | Latest stable / release | Weekly downloads | Approval implication |
| --- | --- | --- | --- |
| ESLint | 10.13.0 / 2026-10-16 | 102,207,674 | Strong adoption, competing choice: owner ruling required |
| typescript-eslint | 8.72.0 / 2026-10-19 | 58,934,498 | Typed candidate; security process and chosen-layer record still required |
| React hooks plugin | 7.1.1 / 2026-04-17 | 63,108,579 | First-party recommendation, no automatic ecosystem approval |
| JSX accessibility plugin | 6.10.2 / 2024-10-26 | 33,212,419 | Fails criterion c's release-within-12-months test; omit from hybrid |
| Playwright plugin | 2.12.1 / 2026-10-05 | 3,316,646 | Community plugin, distinct from approved Playwright |
| React plugin | 7.37.5 / 2025-04-03 | 40,606,555 | Fails release-age criterion; full replacement dependency |
| Import plugin | 2.32.0 / 2025-06-20 | 40,331,000 | Fails release-age criterion; full replacement dependency |

Primary per-package URLs and exact timestamps are in that snapshot. Registry maintainers are identities, not verification of a security process. Release age is the owner's mechanical criterion, not a claim that a quiet package is broken. The full replacement therefore cannot receive delegated approval merely because its package names are familiar.

## Time, architecture and exit

On the recorded Apple M5 Max / Darwin arm64 / Node v26.7.0 environment, three sequential successful `npm run lint` runs took **2.101, 2.134 and 1.967 seconds** (median **2.101 s**), including oxlint, Stylelint and copy checks. This is a local baseline, not CI PR latency. [typescript-eslint's performance guidance](https://typescript-eslint.io/troubleshooting/typed-linting/performance/) explains the type-checking cost; no unmeasured speedup is claimed for either candidate.

After an owner ruling, compare the same candidate commit, runner, cache conditions and file scope with warm and cold runs of both lint and the complete PR tier. Require no PR-tier slowdown against its measured control. Record CPU/memory and the added typed-program cost. Syntax checks on changed files alone cannot substitute for full type-aware correctness. Do not add a timing threshold from this workstation to CI.

Proposed layer: build/tooling for ESLint and TypeScript/hooks lint integration; test for Playwright lint integration. Proposed allowed package: root `console-react`, configuring `@console/web`, neutral packages and browser-test sources through explicit file scopes. Nothing may be imported by production application code. Approval must enumerate exact packages/pins, security/licence evidence, scopes and an exit plan in the frontend module map before installation; this ADR is not that ruling.

Exit: remove a linter/plugin only when the surviving approved tool catches all its planted negative cases with identical exceptions and no PR-tier slowdown. Regenerate the rule snapshot, ledger and locks in the replacement slice. Rollback is the prior reviewed config and lock, never a disabled check. Maintain this ADR when rule coverage, plugin maintenance or the owner ruling changes.

Reproduce evidence: `node scripts/quality/linter-evidence.mjs` verifies the installed-config/probe snapshot offline; `--write` regenerates it and measures lint. `--refresh` refreshes proposed-package metadata without installing anything. These commands are evidence generation, not new CI gates. The [verification note](../quality/tooling-validation.md) records the inherited local test failures and remaining release proof.
