// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import type { ReadState } from "../../../lib/react/query-view";
import { buttonClass } from "../../../ui/button/button-class";
import { FormPattern } from "../../../ui/patterns/form";
import { FormRow, FormRowList, FormSection } from "../../../ui/patterns/form-section";
import { RecordPattern } from "../../../ui/patterns/record";
import { myRequestsQuery } from "../api";
import s from "./requests.module.css";

const READY_READ: ReadState = { isPending: false, error: null, data: { ready: true }, refetch: () => {} };

export function RequestLookupConsole({
  sections,
  actions,
  onSubmit,
}: {
  sections: ReactNode;
  actions: ReactNode;
  onSubmit: () => void;
}) {
  const myQ = useQuery({ ...myRequestsQuery, retry: false });
  const items = myQ.data?.items ?? [];

  return (
    <div className={s.lookupHost}>
      <FormPattern
        q={READY_READ}
        head={{ title: t("requestOutcome.title") }}
        sections={
          <>
            <FormSection>{sections}</FormSection>
            {items.length > 0 && (
              <FormSection>
                <h2>{t("requestOutcome.myHistory.title")}</h2>
                <FormRowList label={t("requestOutcome.myHistory.title")}>
                  {items.map((r) => (
                    <FormRow
                      key={r.id}
                      primary={
                        <div className="row">
                          <strong>{t("requestOutcome.myHistory.col.id")}</strong>
                          <code className="code">{r.id}</code>
                        </div>
                      }
                      end={
                        <div className="row">
                          <bdi className="muted t-xs">{t("requestOutcome.myHistory.col.state")}</bdi>
                          <strong className="t-xs">{t(`requestOutcome.${r.state}`)}</strong>
                          <Link to="/requests/$id" params={{ id: r.id }} className={buttonClass("secondary", { size: "sm" })}>
                            {t("requestOutcome.myHistory.open")}
                          </Link>
                        </div>
                      }
                      secondary={
                        <>
                          {t("requestOutcome.myHistory.col.created")} ·{" "}
                          <time dateTime={r.created_at}>{fmtDateTime(r.created_at)}</time>
                        </>
                      }
                    />
                  ))}
                </FormRowList>
              </FormSection>
            )}
          </>
        }
        actions={actions}
        onSubmit={onSubmit}
      />
    </div>
  );
}

export function RequestPageConsole({
  q,
  own,
  sections,
}: {
  q: ReadState;
  own: (code: string) => string | undefined;
  sections: ReactNode;
}) {
  return (
    <RecordPattern
      q={q}
      own={own}
      back={{ to: "/requests", label: t("requestOutcome.lookup") }}
      head={{
        title: t("requestOutcome.title"),
        actions: (
          <Link to="/requests" className={buttonClass("secondary", { size: "sm" })}>
            {t("requestOutcome.lookup")}
          </Link>
        ),
      }}
      sections={<FormSection>{sections}</FormSection>}
    />
  );
}
