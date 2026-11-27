// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { COPY } from "../copy";
import s from "./external-url.module.css";

export function ExternalUrl({ value }: { value: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const timeout = window.setTimeout(() => setStatus("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const handleCopy = async () => {
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <span className={s.row}>
      <code className={s.text} title={value}>{value}</code>
      <button type="button" className="btn btn--sm" onClick={handleCopy} disabled={status === "copying"} aria-label={`${COPY.alerts.detail.copy}: ${value}`}>
        {status === "copied" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        <span>{status === "copied" ? COPY.alerts.detail.copied : COPY.alerts.detail.copy}</span>
      </button>
      <span role="status" className={status === "failed" ? undefined : "sr-only"}>
        {status === "failed" ? COPY.alerts.detail.copyFailed : status === "copied" ? COPY.alerts.detail.copied : null}
      </span>
    </span>
  );
}
