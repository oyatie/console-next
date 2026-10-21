import { useState } from "react";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { ENTITY_READS, settleNameReview } from "../api";
import { ReviewNameCorrection } from "./name-correction";
import { EntityError } from "./entity-error";

type Review = NonNullable<LegalEntity["name_reviews"]>[number];

/** One review on the record: both names, and one action for each. */
export function NameReview({ e, review, editable }: { e: LegalEntity; review: Review; editable: boolean }) {
  const [taking, setTaking] = useState(false);
  const keep = useCommand({ run: (_: undefined, key: string) => settleNameReview(key, e.id, review.id, {}), invalidates: ENTITY_READS, settle: true });
  return <li data-problem="legal_name_review">
    {t("entity.name.review", { entity: review.entity_name, registration: review.registration_name })}{" "}
    {editable && <>
      <Button variant="ghost" onClick={() => keep.mutate(undefined)} disabled={keep.isPending}>{t("entity.name.reviewKeep")}</Button>
      <Button variant="ghost" onClick={() => setTaking(true)}>{t("entity.name.reviewTake")}</Button>
    </>}
    <EntityError error={keep.error} />
    {taking && <ReviewNameCorrection e={e} review={review} onClose={() => setTaking(false)} />}
  </li>;
}

