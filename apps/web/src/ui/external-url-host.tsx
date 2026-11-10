// SPDX-License-Identifier: LicenseRef-Proprietary
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

export function ExternalUrlHost({ hostname }: { hostname: string }) {
  // shortcut: all IDNs shown as punycode, upgrade when UTS #39 single-script check lands
  const { subdomain, registrable } = splitHost(hostname);
  return <>{subdomain && <span>{subdomain}</span>}<strong className={styles.registrable}>{registrable}</strong></>;
}
