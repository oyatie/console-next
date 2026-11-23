// SPDX-License-Identifier: LicenseRef-Proprietary
import { AlertTriangle } from "lucide-react";
import { COPY } from "../copy";
import { classifyMutationError } from "../lib/auth";
import { fmtJoin, formatUtcTimestamp } from "../lib/format";
import { Badge } from "./badge";
import s from "./inline-error.module.css";

export function InlineError({
  error,
  onReloadConflict,
}: {
  error: unknown;
  onReloadConflict?: () => void;
}) {
  if (!error) return null;
  const model = classifyMutationError(error);

  return (
    <div className={s.banner} role="alert">
      <div className={s.head}>
        <AlertTriangle size={14} aria-hidden="true" />
        <strong className={s.reason}>{model.reason}</strong>
        <Badge tone="danger">{fmtJoin(COPY.o0.httpStatusPrefix, " ", String(model.status))}</Badge>
        <code className={s.metaCode}>{model.code}</code>
      </div>
      <p className={s.message}>{model.message}</p>
      <div className={s.meta}>
        <span>{fmtJoin(COPY.o0.supportRefLabel, ": ", model.supportRef)}</span>
        <span>·</span>
        <span>{fmtJoin(COPY.o0.evaluatedAtLabel, ": ", formatUtcTimestamp(model.evaluatedAt))}</span>
        {model.isConflict && onReloadConflict ? (
          <button type="button" className="btn btn--sm btn--primary" onClick={onReloadConflict}>
            {COPY.incidents.reloadConflict}
          </button>
        ) : null}
      </div>
    </div>
  );
}
