// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { externalUrlValue } from "./external-url-value";
import styles from "./external-url.module.css";

/** Source titles and their destinations stay plain text beside the current task. */
export function ExternalLink({href,children,className}:{href:string;children:ReactNode;className?:string}) {
  const value = externalUrlValue(href);
  return <cite className={[styles.text, className].filter(Boolean).join(" ")}
    data-refusal-code={value ? undefined : "external_url_https_required"}>
    {children} · {value ? value.href : t("common.failed.code.external_url_https_required")}
  </cite>;
}
