// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useEffect, useRef } from "react";
import { Copy } from "lucide-react";
import { t } from "@console/i18n";
import { externalUrlValue } from "./external-url-value";
import { announce } from "../lib/react/announce";
import { IconButton } from "./button/button";
import styles from "./external-url.module.css";
import { chunk } from "../lib/chunk-guard";

const ExternalUrlHost = lazy(() => chunk(import("./external-url-host")).then(module => ({ default: module.ExternalUrlHost })));

interface ExternalUrlProps {
  href?: string;
  url?: string;
  className?: string;
}

/**
 * Renders an external URL as inert text with a copy button for https: destinations.
 * Never renders an <a> anchor. IDN and mixed-script hosts render as punycode with
 * the registrable domain emphasised.
 */
export function ExternalUrl({ href: propHref, url, className }: ExternalUrlProps) {
  const href = propHref ?? url ?? "";
  return <ExternalUrlValue key={href} href={href} className={className} />;
}

function ExternalUrlValue({ href, className }: { href: string; className?: string }) {
  const copyAttempt = useRef(0);
  useEffect(() => () => { copyAttempt.current++; }, []);

  const parsed = externalUrlValue(href);

  if (!parsed) {
    return <span className={[styles.text, className].filter(Boolean).join(" ")}>{href}</span>;
  }

  const schemePrefix = `${parsed.protocol}//`;
  const userinfo = parsed.username || parsed.password
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  const port = parsed.port ? `:${parsed.port}` : "";
  const rest = parsed.href.slice(parsed.href.indexOf("/", schemePrefix.length));

  const handleCopy = async () => {
    const attempt = ++copyAttempt.current;
    try {
      await navigator.clipboard.writeText(parsed.href);
      if (attempt === copyAttempt.current) announce(t("uiField.copiedUrl"));
    } catch {
      if (attempt === copyAttempt.current) announce(t("uiField.copyUrlFailed"));
    }
  };

  return (
    <span className={[styles.root, className].filter(Boolean).join(" ")}>
      <span className={styles.text}>
        <span>{schemePrefix}</span>
        {userinfo && <span>{userinfo}</span>}
        <Suspense fallback={<strong className={styles.registrable}>{parsed.hostname}</strong>}>
          <ExternalUrlHost hostname={parsed.hostname} />
        </Suspense>
        {port && <span>{port}</span>}
        {rest && <span>{rest}</span>}
      </span>
      <IconButton label={t("uiField.copyUrl")} size="sm" onClick={handleCopy}>
        <Copy size={14} aria-hidden />
      </IconButton>
    </span>
  );
}
