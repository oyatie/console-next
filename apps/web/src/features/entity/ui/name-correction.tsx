import type { LegalEntity } from "@console/api/pending";
import { settleNameReview } from "../api";
import { ReviseSheet } from "./record-revise-sheet";
import { nameCorrection } from "./name-correction-spec";

/** Take a review's certificate trade name as the legal name: a dated correction that settles the review in one command. */
export function ReviewNameCorrection({ e, review, onClose }: { e: LegalEntity; review: NonNullable<LegalEntity["name_reviews"]>[number]; onClose: () => void }) {
  const spec = { ...nameCorrection(e, review.registration_name), submit: (key: string, revision: Parameters<typeof settleNameReview>[3]["revision"] & object) => settleNameReview(key, e.id, review.id, { revision }) };
  return <ReviseSheet e={e} spec={spec} onClose={onClose} />;
}
