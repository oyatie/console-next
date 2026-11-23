// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { COPY } from "../copy";
import type { OpsCmdHandOff } from "../lib/api";
import { fmtJoin, formatUtcTimestamp } from "../lib/format";
import { ExternalUrl } from "./external-url";
import { KeyValue } from "./key-value";
import s from "./cmd-receipt.module.css";

export function CmdReceipt({
  action,
  showActionsLink = true,
}: {
  action: OpsCmdHandOff;
  showActionsLink?: boolean;
}) {
  return (
    <section className={s.receipt} aria-label={COPY.actions.detailTitle}>
      <div className={s.head}>
        <strong className={s.title}>{fmtJoin(action.action_id, " · ", action.kind)}</strong>
        {showActionsLink ? (
          <Link to="/actions" className="btn btn--sm">
            {COPY.actions.viewAll}
          </Link>
        ) : null}
      </div>
      <div className={s.cmdRow}>
        <span className={s.cmdLabel}>{COPY.actions.fields.command}</span>
        <ExternalUrl value={action.command} />
      </div>
      <KeyValue
        items={[
          { id: "target", label: COPY.actions.cols.target, value: <code>{action.target}</code> },
          { id: "consequence", label: COPY.actions.fields.consequence, value: action.consequence },
          { id: "expected", label: COPY.actions.fields.expected, value: action.expected_result },
          { id: "verify", label: COPY.actions.fields.verify, value: action.verify_step },
          { id: "operator", label: COPY.actions.cols.operator, value: action.operator },
          { id: "at", label: COPY.actions.cols.at, value: formatUtcTimestamp(action.at) },
        ]}
      />
    </section>
  );
}
