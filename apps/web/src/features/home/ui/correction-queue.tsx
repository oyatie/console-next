// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTimeShort } from "@console/i18n/format";
import type { IdentifierCorrectionCase } from "../../../reference/entity/api";
import { todayKst } from "../../../lib/pure/today";
import { buttonClass } from "../../../ui/button/button-class";
import { DDay, QueueSection } from "./change-rows";

// shortcut: Home's existing queue until eco-g2-inbox absorbs this awaiting=me source.
export function CorrectionQueue({ items, more, today }: { items: IdentifierCorrectionCase[]; more: boolean; today: string }) {
  return (
    <QueueSection id="corrections" title={t("home.corrections.title", { count: items.length })}>
      <ul className="list-plain">
        {items.map((item) => <li key={item.id} className="row">
          {item.review_due_at && <><time dateTime={item.review_due_at}>{fmtDateTimeShort(item.review_due_at)}</time><DDay date={todayKst(new Date(item.review_due_at))} today={today} /></>}
          <Link className="grow" to="/org/entities" search={{ correction: item.id }} hash="identifier-corrections">
            {item.entity_name} · {t(`entityRecord.corrections.status.${item.status}`)} · {t(item.can_apply ? "entityRecord.corrections.apply" : item.can_review ? "entityRecord.corrections.review" : "home.corrections.decide")}
          </Link>
        </li>)}
      </ul>
      {more && <Link to="/org/entities" hash="identifier-corrections" className={buttonClass()}>{t("home.corrections.more")}</Link>}
    </QueueSection>
  );
}
