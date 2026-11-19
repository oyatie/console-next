<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Settings change brief

- Product behavior and affected readers/writers:
- Registry key(s), kind, units, bounds, default, governance and legal basis:
- Cedar action and facts for any changed access decision:
- User-facing copy and affected screens:

## Implementation and proof

1. Add a regression test first and show it fails before the change.
2. Declare keys in `console-settings-domain`; reuse existing resolution and validation.
3. Follow [Adding a settings key](../engineering.md#adding-a-settings-key) for the
   `contract` migration header, generated row upserts for additions and changes, compatibility
   and retirement rules, and exact checks against a disposable test database.
4. For UI changes, include gallery states, browser component tests and touched journeys.
