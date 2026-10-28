<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# API type generator evaluation

Date: 2026-10-28. Status: **proposed**. Decision owner: Jason Lee. Scope: API declaration generation and frontend build/tooling. No generator, compiler, dependency declaration, lockfile, API contract, or generated product file changes with this decision.

**Recommendation: OWNED.** Approve a small owned text emitter that preserves the existing `paths`, `operations`, and `components` interfaces. Include an explicit build/tooling declaration of `js-yaml@4.3.2` (MIT) in that approval: existing contract checks already import it through a transitive dependency, which would disappear when the current generator is removed. Record the approval and permitted layer in the architecture and dependency register before implementation. The prototype demonstrates feasibility; it is not ready to replace the generator.

The compiler pin is a tooling constraint, not a requirement of our API declarations. The current generated declarations typecheck the web under TypeScript 5.9.3, 6.0.2, and 7.0.2. The current generator runs with 6.0.2 despite its `^5.x` peer declaration, but crashes with 7.0.2. Replacing it with Hey API reproduces the same compiler API problem. Orval has a different output interface and cannot generate from the complete committed contract in this probe.

## Requirements and current contract

- Preserve the package exports and `openapi-fetch` inference: path and method selection, required path/query/header parameters, request bodies, status-specific responses, and content types. Preserve both application and ops documents.
- Preserve required versus optional fields, defaults, nullable references, closed enums versus extensible vocabulary, unions, intersections, discriminators, arrays/tuples, dictionaries, and local references. Unsupported shapes must fail explicitly rather than become `any` or an unnoticed `unknown`.
- Emit declarations as text without the TypeScript JavaScript compiler API. Verify the emitted contract with each supported compiler independently of the generator runtime.
- Keep deterministic, byte-for-byte drift checks against the contract at the paired Git commit. Keep missing input/output, generator failure, manual-edit, and changed-contract refusals.
- Introduce no vulnerable or archived dependency, obtain owner approval for new direct declarations, and keep all tooling out of the browser bundle. A permissive licence alone is insufficient approval.

The application document contains 738 paths, 863 operations, and 1,453 schemas; ops contains 9 paths, 9 operations, and 64 schemas. Counts below include inline schemas and nested occurrences, not just named models.

| Construct | Application | Ops | Compatibility implication |
| --- | ---: | ---: | --- |
| `x-extensible-enum` | 32 | 0 | Open string vocabulary, including `AccessDomain` and an export-format query; do not turn these into closed unions. |
| `nullable` | 483 | 0 | Includes `$ref` siblings; different generators interpret these differently. |
| `oneOf` / `anyOf` / `allOf` | 189 / 52 / 64 | 3 / 18 / 16 | Includes null alternatives and composed object shapes. |
| `discriminator` | 9 | 1 | Retain narrowing and required discriminator fields. |
| `additionalProperties` | 429 | 5 | Includes false, true, and typed dictionaries. |
| `enum` / `const` | 765 / 5 | 25 / 21 | Keep literals and their nullability. |
| `$ref` | 7,380 | 237 | Includes shared parameters/responses as well as schemas. |
| `prefixItems` / `not` | 1 / 0 | 0 / 2 | A model-only or primitive-only emitter is insufficient. |

An AST inventory of imports in `apps/web/src`, `packages/api/src`, and `e2e` finds 221 files importing `components`, 12 importing `paths`, and one importing `operations`. These groups overlap. `packages/api/src/index.ts` re-exports `paths` and `components`; `client.ts` passes `paths` to `createClient`. `pending/entity.ts` and feature API files index request/response shapes directly. The `operations` consumer is `org-decision-contract.test.ts`. There are no direct imports of `webhooks` or `$defs`. Package exports also expose `@console/api/schema` and `@console/api/ops-schema`; caller edits are not an acceptable shortcut for this evaluation.

`scripts/check-api-schema.mjs` reads both documents with `git show HEAD:<spec>`, invokes the generator into a temporary directory, and compares exact bytes with the committed declarations. `npm run gen:api` writes both outputs. The ops output receives an SPDX header. `npm run check` also invokes the Rust ops-composition check before the two declaration comparisons. The existing six gate tests cover absent repositories/refs/files, drift, pinning an earlier contract, overrides, ops drift, and composition failure propagation. A replacement must retain those boundaries and error handling.

## Measured results

Input commit: `29d506eeba57`. Node `26.7.0`, npm `12.0.2`, macOS arm64. Application input SHA-256: `6def6cd252122c1a540f8976d87d07b75b98a5e2fda205d95db0856337737585`; ops: `0da49afe827f4aa6b9367b397eff1180111b02c6ab03b325e5fc2fb8c916f8ff`.

Each tool was installed in a separate temporary project outside Git worktrees with scripts and automatic peer installation disabled. Explicit compiler versions avoid mistaking a nested compiler for the requested version. Source snapshots use the repository's compiler settings, disable incremental caching, and redirect the `@console/api` exports to the candidate output. App, API, and i18n sources, including their tests and galleries, are checked; E2E entry points are excluded from this web compatibility matrix. Transitive source imports remain included. Generated files retain their native directory layout behind the temporary schema export.

| Candidate | Generation with TS 5.9.3 | TS 6.0.2 runtime | TS 7.0.2 runtime | Web diagnostics: 5.9 / 6.0 / 7.0 | Public interface |
| --- | --- | --- | --- | --- | --- |
| `openapi-typescript@7.13.0` (control) | Pass | Pass, outside declared peer range | Fail: missing `ts.factory` | 0 / 0 / 0 | Existing maps |
| `@hey-api/openapi-ts@0.99.0`, TypeScript plugin only | Pass | Pass | Fail: missing `ts.SyntaxKind.AnyKeyword` | 2,256 / 2,255 / 2,255 | Named models and operation data/responses; no compatible maps |
| `orval@8.45.0`, schemas output | Fail on full contract | Same contract failure | Same contract failure | No output to check | Named schemas; no compatible maps |
| Orval, supplementary model-only probe | Pass | Not separately probed | Not separately probed | 2,256 / 2,255 / 2,255 | Named schemas; paths intentionally omitted |
| Owned text prototype + `js-yaml@4.3.2` | Pass | No compiler used by emitter | No compiler used by emitter | 0 / 0 / 0 | Existing map names; incomplete semantics |

The TypeScript 6/7 columns describe generator execution, while the diagnostics column describes consuming declarations generated successfully beforehand. They are separate checks. Orval also brings its own nested TypeScript 6.0.3, regardless of the explicit scratch root compiler. A broad peer range is not evidence that a generator supports the TypeScript 7 API.

Orval's default validation rejects the extra response key `reused idempotency key or inactive lifecycle event` at the statutory insurance-filing POST's 409 response. An additional run with `unsafeDisableValidation: true` proceeds further but fails because `entityId` is absent from the parameters for `listEntityWorkplaces`. No backend fragment was edited. For a supplementary assessment of model output, an input transformer removes `paths` from the parsed scratch document. That produces models, but is explicitly not successful generation of the full contract. Its typecheck still refuses the missing `components`/`paths`/`operations` exports. The same export failures dominate Hey API's diagnostics; their counts measure an unadapted replacement, not the amount of migration work.

Generation was repeated twice per successful configuration. These are process wall times, not a statistically controlled benchmark. Output size is the sorted concatenation of generated TypeScript files, with one newline between files. Diff counts compare that text with the current application declaration; they include formatting, comments, and barrels and do not measure semantic change.

| Output | Two generation times (s) | Files / bytes / lines | Diff: added / removed lines | Repeat hash equal |
| --- | --- | --- | --- | --- |
| Current generator | 1.090 / 1.171 | 1 / 2,312,780 / 60,354 | 0 / 0 | Yes |
| Hey API | 1.549 / 1.685 | 2 / 1,540,105 / 52,567 | 52,090 / 59,877 | Yes |
| Orval, full contract | 0.441 / 0.454, both failed | 0 / 0 / 0 | No emitted output | Not applicable |
| Orval, model-only subset | 1.453 / 1.335 | 2,213 / 1,198,558 / 44,897 | 44,895 / 60,352 | Yes |
| Owned prototype | 0.116 / 0.121 | 1 / 1,239,019 / 3,043 | 3,043 / 60,354 | Yes |

The prototype's compact formatting accounts for much of its line reduction. It omits descriptions and is not a proposed output style. Its SHA-256 is `0c664039ca56f1b2245a4d290fbb4ecdcc267623e0e11cecb8ef9977d5569ffd`.

The prototype passed ten positive type assertions and four `@ts-expect-error` controls on each compiler: extensible strings, nullable objects/references, unions, intersections, dictionary values, tuples, status-specific content, and required path parameters. An earlier prototype incorrectly represented nullable object alternatives; its web check refused the existing `people-exits` mock. Fixing null handling changed that result from one diagnostic on each compiler to zero. These are scratch evaluation controls, not new product tests.

**Compilation does not establish parity.** Comparing every named application schema bidirectionally with the current generator found 1,385 mutually assignable shapes and 68 differences, including nullable-reference propagation, `EntitySetupOp`, and `WorkplaceInput`. The prototype does not implement all schema combinations, discriminator refinement, ops `not`, or fail-closed keyword validation. Those differences must be explained against the backend contract and covered with positive and negative tests before replacement; silently preserving a legacy generator bug is not the goal either. Ops generation and parameter/response-map parity remain adoption gates.

## Dependency and maintenance evidence

Counts include every resolved package in each scratch lock, including the candidate, explicit compiler, nested packages, and optional entries; they exclude the scratch project itself. The owned emitter has only its YAML parser and `argparse`.

| Candidate | Resolved packages | Licence counts | npm audit | OSV querybatch | Archived GitHub repositories in graph |
| --- | ---: | --- | --- | --- | --- |
| Current generator, freshly resolved | 33 | MIT 26; ISC 3; Apache-2.0 2; Python-2.0 1; MIT OR CC0-1.0 1 | 0 | 0 affected versions | `require-from-string@2.0.2`, `yaml-ast-parser@0.0.43` |
| Hey API | 52 | MIT 45; ISC 4; Apache-2.0 1; BSD-2-Clause 1; Python-2.0 1 | 0 | `js-yaml@4.2.0`: three advisories | None found |
| Orval | 109 | MIT 98; ISC 4; Apache-2.0 3; BSD-2-Clause 1; BSD-3-Clause 1; Python-2.0 1; MIT OR CC0-1.0 1 | 0 | 0 affected versions | `require-from-string@2.0.2` |
| Owned emitter's proposed parser graph | 2 | MIT 1; Python-2.0 1 | 0 | 0 affected versions | None found |

OSV identified [GHSA-2883-xcg3-v3hh](https://osv.dev/vulnerability/GHSA-2883-xcg3-v3hh), [GHSA-52cp-r559-cp3m](https://osv.dev/vulnerability/GHSA-52cp-r559-cp3m), and [GHSA-5p4m-2wfm-xmqj](https://osv.dev/vulnerability/GHSA-5p4m-2wfm-xmqj) for Hey API's pinned YAML parser. `npm audit` returned zero for that graph; both outputs are retained instead of treating one database's silence as clearance. The parser is build tooling consuming a committed contract, but it still fails the stated dependency requirement. The proposed owned graph uses 4.3.2. `Python-2.0` is permissive but is absent from the repository's current production licence allowlist; parser adoption must explicitly review that transitive licence as well as the new declaration. There are no npm deprecation flags in these locks. Archive checks covered 109 distinct GitHub repositories; archive status is a repository signal, not proof that an older release branch is maintained.

The historical vulnerable-Redocly report does not mean every fresh current-generator install is vulnerable: this scratch lock resolved `@redocly/openapi-core@1.34.22` and `js-yaml@4.3.2`. Separately, the repository-wide existing lock audit reports two moderate findings in `qs`/`typed-rest-client`; these are not attributed to the generator-only graph and were not changed here.

Primary maintenance sources, checked on the evaluation date:

- [`openapi-typescript` 7.13.0](https://github.com/openapi-ts/openapi-typescript/releases/tag/openapi-typescript%407.13.0) was published 2026-02-11. The maintainer's [maintenance-mode notice (#2874)](https://github.com/openapi-ts/openapi-typescript/issues/2874) explicitly says there will be no further updates, including security updates. The repository archive flag remains false. [TS 6 support](https://github.com/openapi-ts/openapi-typescript/issues/2723), [TS 7 failure](https://github.com/openapi-ts/openapi-typescript/issues/2841), and the [YAML dependency report](https://github.com/openapi-ts/openapi-typescript/issues/2846) remain open. PR 2862 is documentation, not a released compatibility fix.
- [Hey API 0.99.0](https://github.com/hey-api/hey-api/releases/tag/%40hey-api%2Fopenapi-ts%400.99.0) was published 2026-06-22. The repository is active and unarchived; the latest push observed was 2026-09-30. Its peer range includes 6 and numerically permits 7, but the open [TS 7 issue](https://github.com/hey-api/hey-api/issues/4235) matches the measured crash. Its [TypeScript plugin](https://heyapi.dev/openapi-ts/plugins/typescript) documents named request/response/model output. Pre-1.0 configuration churn and a compatibility adapter would be additional migration costs.
- [Orval 8.45.0](https://github.com/orval-labs/orval/releases/tag/v8.45.0) was published 2026-10-25, following 8.44.0 on 2026-10-21. The repository is active and unarchived, with a push observed on 2026-10-28. A search for open issues containing TypeScript found no TS 6/7 compatibility issue among its three matches; that is a dated search result, not a support guarantee. Its [output configuration](https://orval.dev/docs/reference/configuration/output/) supports schemas, but its client/hook ecosystem and archived transitive dependency exceed this declaration-only job.
- Microsoft's [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) confirms the native compiler transition. Registry publication timestamps were independently captured for 5.9.3, 6.0.2 (2026-03-23), and 7.0.2 (2026-07-08). No preview compiler was substituted for the requested majors.

## Migration plan and option risks

Approve **OWNED** to authorize this plan and the proposed build-only parser declaration; approval does not authorize shipping the prototype. This is the only evaluated direction without a compiler API dependency, a new client architecture, or an archived package in its proposed dependency graph.

1. Record owner approval at the frontend build/tooling architecture layer and in the dependency register. Specify the parser and transitive licence decision. Keep the current generator installed during parity work so rollback remains a generator/configuration revert, with no application edits.
2. Build the emitter behind the existing contract gate. Reuse the repository's YAML/reference validation conventions and own-property lookup helper. Add fail-closed controls for unresolved/external refs, unknown type-bearing keywords, duplicate operation IDs, unsupported content, and emission failure. Prove the common schema mechanism and one real operation before extending coverage.
3. Complete application and ops coverage in separate small slices. Resolve all 68 observed schema differences and compare operation, parameter, body, header, and response maps. Keep `x-extensible-enum` open. Use fixtures plus compiler negative controls to catch accidental widening as well as narrowing. Cover the real `oneOf`/nullable/allOf/discriminator/tuple/`not` forms rather than claiming general JSON Schema support.
4. Switch generation only after both documents pass the existing drift/refusal tests, repeated output is identical, and the web plus the complete root TypeScript project pass. Remove `openapi-typescript` only after every remaining transitive import has an explicit approved owner. Re-run audit, OSV, licence inventory, and archive checks on the final lock.
5. Upgrade the existing TypeScript dependency in a separate slice, first to 6 and then to 7 after the remaining build tools and full project pass their compatibility checks. The web-only matrix is green with the existing declarations; the full root TS 6/7 probe also exposed an unrelated WebAuthn cast in `e2e/support-access.spec.ts`. Do not hide it with broader casts in generated types. Run Chromium journeys for any affected screen or E2E changes before that slice is ready.

The owned option transfers semantic correctness and maintenance to this repository; the prototype's parity differences make that risk concrete. Hey API offers maintained upstream ownership but currently needs a different output interface, a compiler API workaround, and a YAML security fix. Orval offers frequent releases but needs contract repairs plus an interface adapter or client migration and dependency reduction. Retaining the current generator is a temporary rollback option with zero declaration churn, but its explicit end of maintenance makes it unsuitable as the long-term recommendation. A side-by-side older compiler can decouple generation from TS 7 consumption, but adds a dependency/alias decision and leaves the generator's maintenance problem unresolved.

## Commands, outputs, and verification boundaries

Raw outputs are kept outside the repository.

```sh
# From the repository, before any candidate execution:
git show 29d506eeba57:backend/openapi/openapi.yaml > "$EVAL_DIR/openapi.yaml"
git show 29d506eeba57:backend/openapi/ops.yaml > "$EVAL_DIR/ops.yaml"
# In each separate scratch project, with exact dependencies in its package.json:
npm install --ignore-scripts --no-fund --no-audit --legacy-peer-deps --cache "$EVAL_DIR/npm-cache"
node node_modules/openapi-typescript/bin/cli.js ../openapi.yaml -o out/schema.d.ts
node generate.mjs # Hey API: plugins: ['@hey-api/typescript']
node node_modules/orval/dist/bin/orval.mjs --config orval.config.mjs
node node_modules/orval/dist/bin/orval.mjs --config models.config.mjs # labelled subset only
node owned/emit.mjs openapi.yaml owned.d.ts # from the scratch root
node "$COMPILER_DIR/bin/tsc" -p tsconfig.json --pretty false # in each source snapshot
npm audit --json --cache "$EVAL_DIR/npm-cache"
# OSV: POST https://api.osv.dev/v1/querybatch with exact npm names and locked versions.
# Archive status: gh api repos/<owner>/<repo> for every observed GitHub repository.
```
