// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { codeText } from "../../../lib/code-text";
import { QueryState } from "../../../lib/react/query-state";
import { buttonClass } from "../../../ui/button/button-class";
import { Pager } from "../../../ui/pager";
import { FormRow, FormRowList } from "../../../ui/patterns/form-section";
import { myRequestsQuery } from "../api";

export function RequestHistory() {
  const [offset, setOffset] = useState(0);
  const history = useQuery({ ...myRequestsQuery(offset), retry: false });
  const title = t("requestOutcome.myHistory.title");
  return <section aria-labelledby="my-request-history">
    <h2 id="my-request-history">{title}</h2>
    <QueryState q={history} compact>
      {page => <>
        {page.items.length ? <FormRowList label={title}>
          {page.items.map(receipt => {
            const target = receipt.masked ? undefined : receipt.touched[0]?.type;
            const label = target ? codeText(`accessLog.target.${target}`, "") : "";
            return <FormRow key={receipt.id}
              primary={<strong>{label || t("requestOutcome.title")} · {t(`requestOutcome.${receipt.state}`)}</strong>}
              secondary={<><time dateTime={receipt.created_at}>{fmtDateTime(receipt.created_at)}</time> · <code className="code">{receipt.id}</code></>}
              end={<Link to="/requests/$id" params={{ id: receipt.id }} className={buttonClass("secondary", { size: "sm" })}>
                {t("requestOutcome.myHistory.open")}
              </Link>}
            />;
          })}
        </FormRowList> : t("requestOutcome.myHistory.empty")}
        <Pager offset={page.offset} limit={page.limit} total={page.total} onPage={setOffset} />
      </>}
    </QueryState>
  </section>;
}
