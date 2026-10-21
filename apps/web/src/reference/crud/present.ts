import { ApiError } from "@console/api";
import { isMessageId, t } from "@console/i18n";

/**
 * The words for a CRUD end refusal (`crud.refused.<code>`: why a record is not deleted, closed, cancelled or exited), or
 * undefined for a code this catalog does not know. Shared by the structure, entity and people end sheets.
 */
export const refusalText = (code: string | undefined, values?: Record<string, string | number>) => {
  const id = `crud.refused.${code ?? ""}`;
  return isMessageId(id) ? t(id, values) : undefined;
};

/** CommandError's `own`: the server's end refusals in these words. */
export const ownRefusal = (code: string) => refusalText(code);

/** The code of a refused command, if the server answered with one. */
export const codeOf = (e: unknown) => (e instanceof ApiError ? e.code : undefined);
