import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { emptyDraft } from "../domain/draft";
import { BulkEntityRow } from "./bulk-entity-row";

beforeAll(() => loadCatalog("ko"));
test("entity facts are locked while their digest is being previewed or applied", () => {
  const row = { line: 2, draft: { ...emptyDraft(), name: "Example", bizKind: "INDIVIDUAL" as const, representatives: ["Kim"] } };
  const html = renderToStaticMarkup(<BulkEntityRow row={row} set={() => undefined} busy />);
  expect(html).toMatch(/<fieldset[^>]*disabled=""/);
});
