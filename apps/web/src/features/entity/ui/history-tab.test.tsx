import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { RevisionItems } from "./history-tab";

beforeAll(() => loadCatalog("en"));

test("shared revision history renders outside the entity route", () => {
  expect(() => renderToStaticMarkup(<RevisionItems items={[]} />)).not.toThrow();
});
