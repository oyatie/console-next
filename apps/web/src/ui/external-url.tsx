// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef } from "react";
import { Copy } from "lucide-react";
import { t } from "@console/i18n";
import { announce } from "../lib/react/announce";
import { IconButton } from "./button/button";
import styles from "./external-url.module.css";
import suffixList from "../../../../third-party/public-suffix-list/public_suffix_list.dat?raw";

const SUFFIX_RULES = new Set(suffixList.split("\n").filter((line) => line && !line.startsWith("//")));

/** PSL longest-match rules include private tenants, wildcards and exceptions. */
function splitHost(hostname: string): { subdomain: string; registrable: string } {
  if (hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return { subdomain: "", registrable: hostname };
  }
  const parts = hostname.replace(/\.$/, "").split(".");
  let suffixLength = 1;
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join(".");
    if (SUFFIX_RULES.has(`!${suffix}`)) {
      suffixLength = parts.length - i - 1;
      break;
    }
    if (SUFFIX_RULES.has(suffix)) suffixLength = Math.max(suffixLength, parts.length - i);
    if (i > 0 && SUFFIX_RULES.has(`*.${suffix}`)) suffixLength = Math.max(suffixLength, parts.length - i + 1);
  }
  const prefix = parts.slice(0, Math.max(0, parts.length - suffixLength - 1));
  const subdomain = prefix.length ? `${prefix.join(".")}.` : "";
  return { subdomain, registrable: hostname.slice(subdomain.length) };
}

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

  let parsed: URL | null = null;
  try {
    parsed = new URL(href);
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.protocol !== "https:") {
    return <span className={[styles.text, className].filter(Boolean).join(" ")}>{href}</span>;
  }

  // shortcut: all IDNs shown as punycode, upgrade when UTS #39 single-script check lands
  const { subdomain, registrable } = splitHost(parsed.hostname);
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
        {subdomain && <span>{subdomain}</span>}
        <strong className={styles.registrable}>{registrable}</strong>
        {port && <span>{port}</span>}
        {rest && <span>{rest}</span>}
      </span>
      <IconButton label={t("uiField.copyUrl")} size="sm" onClick={handleCopy}>
        <Copy size={14} aria-hidden />
      </IconButton>
    </span>
  );
}
