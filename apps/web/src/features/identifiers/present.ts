// Words for the identifier screens' codes that the generic failure copy says less well.
import { isMessageId, t } from "@console/i18n";

/** An error code this slice words itself (CommandError `own`): number taken, a change ahead of today, SETUP only. */
export const identifiersError = (code: string) => {
  const id = `identifiers.error.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};
