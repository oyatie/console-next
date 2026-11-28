// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import type { ReadState } from "../../../lib/react/query-view";
import { buttonClass } from "../../../ui/button/button-class";
import { FormPattern } from "../../../ui/patterns/form";
import { FormSection } from "../../../ui/patterns/form-section";
import { RecordPattern } from "../../../ui/patterns/record";
import { RequestHistory } from "./request-history";
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
  return (
    <div className={s.lookupHost}>
      <FormPattern
        q={READY_READ}
        head={{ title: t("requestOutcome.title") }}
        sections={
          <>
            <FormSection>{sections}</FormSection>
            <FormSection><RequestHistory /></FormSection>
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
