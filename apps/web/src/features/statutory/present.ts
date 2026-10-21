import { isMessageId, t } from "@console/i18n";

export function filingLabel(code: string) {
  const id = `statutory.${code}`;
  return isMessageId(id) ? t(id) : code;
}
