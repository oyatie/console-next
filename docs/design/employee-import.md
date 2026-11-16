<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Employee import column confirmation

The owner's 2026-11-12 import ruling governs every binding, including an exact catalogue key. Exact keys, tenant memory and synonyms offer suggestions; a person confirms them before any cell is staged or any restricted identifier is sealed. A remembered exclusion remains excluded until the person changes it.

A detected header awaiting confirmation is `needs_confirmation`, with the number of nonblank data rows. `needs_mapping` means no usable header was detected. Both hold the dry run until the operator confirms or skips the sheet.

The column editor is the single place to choose statutory workplace (`workplace`) or physical customer site (`worksite_name`). Once confirmed as workplace, known values bind to this tenant's workplaces. Each unknown value is reviewed in the dry run, where the operator can mark it as a customer site. The per-value answer is remembered and offered on subsequent imports. No additional column-level place-reading step runs after confirmation.
