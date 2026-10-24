// SPDX-License-Identifier: LicenseRef-Proprietary
// Screen-only refusal copy loads with the locale catalog, after sign-in.
export const enCommon = {
  "common.failed.code.site_needs_workplace": "A workplace is not added by an org change. Add it from its legal entity.",
  "common.failed.code.region_branch_retired": "Regions and branches are no longer added or changed on their own. Adding a workplace brings its branch.",
  "common.failed.code.branch_backs_workplace": "This branch belongs to a workplace and closes only with it. Close the workplace instead.",
  "common.failed.code.site_is_a_workplace": "A workplace is renamed, moved, deleted or closed on its legal entity’s workplace screen, not by an org change.",
  "common.failed.code.workplace_kind_not_found": "That workplace kind no longer exists. Reopen the list and pick again.",
  "common.failed.code.children_changed": "Someone changed this list meanwhile. Reopen it and set the order again.",
  "common.failed.code.org_unit_has_members": "People who haven’t left are still in this department or below it, so it wasn’t deleted. Assign them elsewhere first.",
  "common.failed.code.undo_conflict": "The same units changed again after this change, so it wasn’t undone. Undo the later changes first.",
  "common.failed.code.undo_unit_in_use": "A department this change added now has people or departments in it, so it wasn’t undone. Assign the people and move the departments first.",
  "common.failed.code.batch_not_undoable": "An undo can’t be undone. Make the same change again if you need it.",
  "common.failed.code.batch_already_undone": "This change was already undone.",
  "common.failed.code.org_setup_batch_not_found": "The change to undo wasn’t found. Reload the page.",
  "common.failed.code.phase_not_setup": "Operations have started, so this can’t change directly. Draft an org change instead.",
  "common.failed.code.contract_overlap": "The period overlaps an existing contract. Correct the overlapping contract in contract history.",
  "common.failed.code.workplace_not_open_on_date": "Placement cannot start before the workplace or employer opened. Choose a date on or after opening, or another workplace.",
  "common.failed.code.rehire_date_not_after_exit": "Choose a rehire date on or after the retirement date.",
  "common.failed.code.filing_applicability_unverified": "Nothing was saved because filing applicability is unverified. Confirm the required facts, and correct a conflicting birth date in the employee record.",
  "common.failed.code.support_reference_cross_tenant_denied": "This support reference belongs to another customer account.",
  "common.failed.code.support_reference_grant_required": "A diagnostic support grant is required. Ask an administrator for access.",
  "common.failed.code.support_reference_not_found": "Support reference not found. Check the full reference.",
} as const;
