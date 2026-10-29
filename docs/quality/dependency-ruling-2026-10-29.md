<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Catalog font build tooling

Owner approval, 2026-10-29: fontTools/pyftsubset (MIT), build-time only,
for generating web font subsets from the UI catalogs. The owner separately
approved brotli==1.2.0 (MIT) on 2026-10-29 for WOFF2 compression for fontTools
subsets, in build/tooling only. Neither package is shipped as executable web code.

`apps/web/font-subsets.requirements.txt` pins fontTools and the WOFF2 codec with
SHA-256 hashes. `scripts/font-subsets.mjs --write` installs those exact wheels
in an isolated build environment and generates the font, CSS and provenance
manifest. Use Python 3.12 on Linux or Python 3.14 on macOS; unsupported wheels
fail closed. Regeneration: `PYTHON=python3.14 npm run fonts:generate -w @console/web`
on macOS. Builds run the same script with `--check`, which needs only Node and
verifies sorted catalog code points, tool/font inputs and generated asset hashes
offline. Copy edits that preserve the character set need no regeneration. A new
uncovered syllable is a hard failure naming the single regeneration command:
`npm run fonts:generate -w @console/web`.
After a generator-only change, `node scripts/font-subsets.mjs --refresh-inputs`
refreshes the manifest only if the font, lock, descriptors, output hashes and
exact glyph coverage still match; it never regenerates font assets.

The first subset covers boot catalogs and structure/date/canvas controls in both
locales, plus decimal digits for dynamic dates and counts. The 92 upstream optional
faces remain available for other screen copy and user-provided text. Extending
the entrypoint catalogs requires repeating the preload byte and cold-login
proofs; a generated subset is not permission to expand first-load transfer.
Before the first React render, a completed preload is decoded once. If it is
still downloading or decoding fails, the document retains the shared system
font stack. No late font load changes that document's choice.

Alternatives considered: the existing dynamic subsets exceed the preload budget
for the affected controls; a repository-native OpenType/WOFF2 subsetter would
duplicate font parsing, layout and variation processing. Exit: retain the
generated assets until an approved replacement proves identical glyph coverage,
variable weights, layout stability and transfer budgets.
