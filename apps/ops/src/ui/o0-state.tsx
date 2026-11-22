// SPDX-License-Identifier: LicenseRef-Proprietary
import { ShieldAlert, WifiOff } from "lucide-react";
import { COPY } from "../copy";
import type { RefusalModel } from "../lib/auth";
import { fmtJoin, formatUtcTimestamp } from "../lib/format";
import { Badge } from "./badge";
import { KeyValue } from "./key-value";
import s from "./o0-state.module.css";

export function O0State({
  model,
  onRetry,
}: {
  model: RefusalModel;
  onRetry?: () => void;
}) {
  const Icon = model.kind === "503" ? WifiOff : ShieldAlert;

  return (
    <div className={s.frame}>
      <section className={s.panel} data-kind={model.kind} aria-labelledby="o0-title">
        <div className={s.head}>
          <Icon size={20} aria-hidden="true" />
          <h1 id="o0-title" className={s.title}>{model.title}</h1>
          <Badge tone="neutral">{fmtJoin(COPY.o0.httpStatusPrefix, " ", model.kind)}</Badge>
        </div>
        <p className={s.message}>{model.message}</p>
        <p className={s.guidance}>{model.guidance}</p>
        <KeyValue
          items={[
            { id: "reason", label: COPY.o0.reasonLabel, value: model.reason },
            { id: "code", label: COPY.o0.codeLabel, value: <code>{model.code}</code> },
            { id: "ref", label: COPY.o0.supportRefLabel, value: <code>{model.supportRef}</code> },
            { id: "at", label: COPY.o0.evaluatedAtLabel, value: formatUtcTimestamp(model.evaluatedAt) },
            ...(model.showBreakGlass
              ? [{ id: "bg", label: COPY.o0.breakGlassLabel, value: <code>{COPY.o0.breakGlassPath}</code> }]
              : []),
          ]}
        />
        {model.canRetry ? (
          <div className={s.actions}>
            {onRetry ? (
              <button type="button" className="btn btn--primary" onClick={onRetry}>
                {COPY.o0.retry}
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (typeof window !== "undefined") window.location.reload();
              }}
            >
              {COPY.o0.reload}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
