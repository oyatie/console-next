<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: Supersede Dependabot #312 with its four existing npm package bumps and refresh their recorded requirements and pins using `generate-tooling-ledger.mjs --pins`. The owner's 2026-10-26 permission covers version bumps; existing dependency classifications, approvals, users and layers remain as recorded.

Provenance: Checked the npm registry version endpoints on 2026-11-02. Each version, tarball URL, SHA-512 integrity and license matches package-lock.json. All four registry records advertise SLSA provenance attestations; those attestations were not independently verified.

| Package | Version | Registry record | Existing job |
| --- | --- | --- | --- |
| @axe-core/playwright | 4.14.0 | https://registry.npmjs.org/%40axe-core%2Fplaywright/4.14.0 | Browser accessibility tests |
| oxlint | 1.90.0 | https://registry.npmjs.org/oxlint/1.90.0 | JS/TS linting |
| @tanstack/react-query | 5.105.0 | https://registry.npmjs.org/%40tanstack%2Freact-query/5.105.0 | Web query state |
| lucide-react | 1.63.0 | https://registry.npmjs.org/lucide-react/1.63.0 | Web icons |

License: MPL-2.0 for @axe-core/playwright, MIT for oxlint and @tanstack/react-query, ISC for lucide-react. These match the prior releases' license expressions; the existing owner findings are retained.

Security: The lockfile adds no package names or locations. Existing transitive packages axe-core, @tanstack/query-core and oxlint platform bindings receive corresponding version bumps. The axe wrapper's changed `prepare` script uses pnpm to install Playwright and build upstream; our registry install uses its published build and does not run `prepare`. No new install lifecycle hooks are introduced. Node 26 satisfies the new engine floors. No authentication, authorization or JWT dependency changes are included.

`npm audit` on 2026-11-02 reports 11 moderate findings through minimatch in the existing spreadsheet, schema-generation and mutation-testing chains, with no finding for these four packages. This bump does not resolve that separate advisory; no new ignore or override is added.

Before the repair, the exact CI command `npm run check` on dev plus #312 stops with four unrecorded-requirement errors. The existing dependency gate and its refusal tests remain unchanged. Reproduce the pin refresh with `node scripts/quality/generate-tooling-ledger.mjs --pins=npm:<package> --write` for each package above.
