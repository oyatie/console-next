// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import type { AttentionInboxItem } from "./inbox-filter";

const KNOWN_REGISTER_FIELDS = new Set(["birth", "sex", "address", "job", "hire", "contractEnd", "career"]);

type PeopleCheckRow = {
  key: string;
  labelKey:
    | "home.worklist.strip.register"
    | "home.worklist.peopleSubMissing"
    | "home.review.unplaced"
    | "home.review.identity"
    | "home.part.failedActions"
    | "home.worklist.probationEnding"
    | "home.worklist.contractEnding";
  missingFieldKey?: string;
  indent?: boolean;
  count: number;
  to: "/people" | "/people/unplaced";
  search?: Record<string, string>;
};

export function buildPeopleChecks(
  review: components["schemas"]["EmployeeFacets"]["review"],
  items: readonly AttentionInboxItem[],
): PeopleCheckRow[] {
  const rows: PeopleCheckRow[] = [];
  if (review.register_review_required > 0) {
    rows.push({
      key: "register",
      labelKey: "home.worklist.strip.register",
      count: review.register_review_required,
      to: "/people",
      search: { review: "register" },
    });
    const missingItems = items.filter(
      item =>
        item.kind === "register_review" &&
        (item.context?.review_count ?? 0) > 0 &&
        (item.context?.register?.missing_fields?.length ?? 0) > 0,
    );
    const seenFields = new Set<string>();
    for (const item of missingItems) {
      const fieldKey = item.context?.register?.missing_fields?.[0];
      if (!fieldKey || seenFields.has(fieldKey) || !KNOWN_REGISTER_FIELDS.has(fieldKey)) continue;
      seenFields.add(fieldKey);
      rows.push({
        key: `register-${fieldKey}`,
        indent: true,
        labelKey: "home.worklist.peopleSubMissing",
        missingFieldKey: `empCard.reg.item.${fieldKey}`,
        count: item.context!.review_count!,
        to: "/people",
        search: { review: "register" },
      });
    }
  }
  const unplacedCount = review.department_missing ?? review.home_branch_review_required;
  if (unplacedCount > 0) {
    rows.push({ key: "unplaced", labelKey: "home.review.unplaced", count: unplacedCount, to: "/people/unplaced" });
  }
  if (review.identity_review_required > 0) {
    rows.push({
      key: "identity",
      labelKey: "home.review.identity",
      count: review.identity_review_required,
      to: "/people",
      search: { review: "identity" },
    });
  }
  if (review.lifecycle_apply_failed > 0) {
    rows.push({
      key: "failed",
      labelKey: "home.part.failedActions",
      count: review.lifecycle_apply_failed,
      to: "/people",
      search: { review: "failed", status: "all" },
    });
  }
  const probationItem = items.find(item => item.id.startsWith("probation-") && (item.context?.review_count ?? 0) > 0);
  if (probationItem?.context?.review_count) {
    rows.push({
      key: "probation",
      labelKey: "home.worklist.probationEnding",
      count: probationItem.context.review_count,
      to: "/people",
      search: { status: "ACTIVE" },
    });
  }
  const contractCount = (review.contract_ended ?? 0) + (review.contract_ending_before ?? 0);
  if (contractCount > 0) {
    rows.push({
      key: "contract",
      labelKey: "home.worklist.contractEnding",
      count: contractCount,
      to: "/people",
      search: { review: review.contract_ended > 0 ? "contractPast" : "contractSoon" },
    });
  }
  return rows;
}
