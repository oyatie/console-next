/**
 * The text the tenant ops account's step-up is bound to when it covers an identifier correction itself after go-live
 * (decisions #26 item d): the server's `ENTITY_IDENTIFIER_CORRECTION\n{field}\n{canonical value}\n{document_id}`.
 * Numbers are canonical digits, as the server stores them.
 */
export const opsCorrectionLine = (field: "biz_kind" | "crn" | "brn", value: string, documentId: string) =>
  `ENTITY_IDENTIFIER_CORRECTION\n${field}\n${field === "biz_kind" ? value : value.replace(/\D/g, "")}\n${documentId}`;
