<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: ExcelJS 4.4.0 requires uuid ^8.3.0; Dependabot's available update path downgrades ExcelJS instead of patching that child. The root override applies only below ExcelJS and stays within uuid's CommonJS-capable major.

Provenance: uuid 11.1.1 is verified against [npm metadata](https://registry.npmjs.org/uuid/11.1.1); package-lock.json records its registry tarball and SHA-512 integrity. The [upstream manifest](https://github.com/uuidjs/uuid/blob/v11.1.1/package.json) exports a CommonJS entry point. The requirement and resolved pin are recorded in scripts/quality/dependency-verification.json.

License: MIT, as recorded in npm metadata and the lockfile.

Security: The override fixes [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), first patched in 11.1.1. ExcelJS's source uses only UUID v4 in [extended conditional formatting](https://github.com/exceljs/exceljs/blob/v4.4.0/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js). No advisory is dismissed for this package.

Removal condition: Remove when ExcelJS accepts a compatible patched uuid range, or ExcelJS is replaced. Regenerate the lockfile without the override; the audit and conditional-formatting round trip must still pass.

Verification: scripts/dependency-overrides.test.ts requires ExcelJS through CommonJS, writes a workbook with a non-gradient data bar, asserts that its extension has a generated v4 ID, and reads that ID and the cell data back. It also checks the lockfile and installed child against the ledger. Run `npm test -- scripts/dependency-overrides.test.ts` and `npm audit --omit=optional`.

Limit: The prebuilt ExcelJS browser bundle embeds its own uuid. This override patches Node resolution; replacing that browser dependency is slice 3 and remains required.
