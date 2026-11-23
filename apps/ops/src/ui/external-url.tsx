// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { COPY } from "../copy";
import s from "./external-url.module.css";

export function ExternalUrl({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      });
    } else {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <span className={s.row}>
      <code className={s.text} title={value}>{value}</code>
      <button type="button" className="btn btn--sm" onClick={handleCopy} aria-label={`${COPY.alerts.detail.copy}: ${value}`}>
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        <span>{copied ? COPY.alerts.detail.copied : COPY.alerts.detail.copy}</span>
      </button>
    </span>
  );
}
