<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Settings change brief

- Product behavior and affected readers/writers:
- Registry key(s), kind, units, bounds, default, governance and legal basis:
- Cedar action and facts for any changed access decision:
- User-facing copy and affected screens:

## Implementation and proof

1. Add a regression test first and show it fails before the change.
2. Declare keys in `console-settings-domain`; reuse existing resolution and validation.
3. For stored definitions, generate only the new keys’ INSERTs with
   `cargo run -q -p console-settings-domain --example setting_definitions -- <key> [<key> ...]`
   from `backend/`. Put them in a new forward-only migration inserting into
   `setting_definitions`. For changed definitions, update only the affected rows.
   Never replace `setting_definition()` or copy a whole registry snapshot.
   Infrastructure-only read-only keys need no new SQL row.
4. Keep existing override data and the lookup signature compatible with older binaries.
   Prove the upgrade lineage and a fresh install.
5. Run `cargo test -p console-platform-db --test setting_definitions` against a disposable
   lane database and the affected settings suites. The guard must compare every stored
   definition with the Rust registry after all migrations; no pinned SQL file comparison.
6. For UI changes, include gallery states, browser component tests and touched journeys.
