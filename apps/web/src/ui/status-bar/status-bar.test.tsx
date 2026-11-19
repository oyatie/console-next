// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { blocks } from "../../../../../scripts/check-standing-text.mjs";
import { StatusBar } from "./status-bar";

beforeAll(async () => {
  await loadCatalog("ko");
});

test("StatusBar marks the first segment strong by default, supports attention and trailing slots, and omits aria-live", () => {
  const markup = html(
    <StatusBar
      label="Workspace status"
      segments={[
        { id: "scope", content: "All entities" },
        { id: "sync", content: "Synced" },
        { id: "overdue", content: "2 overdue", tone: "attention" },
      ]}
      trailing="Shortcuts ?"
    />,
  );
  expect(markup).toContain('<footer aria-label="Workspace status" data-surface="chrome"');
  expect(markup).toContain('data-tone="strong">All entities</div>');
  expect(markup).toContain('data-tone="default">Synced</div>');
  expect(markup).toContain('data-tone="attention">2 overdue</div>');
  expect(markup).toContain("Shortcuts ?");
  expect(markup).not.toContain("aria-live");
});

test("StatusBar renders nothing when empty and adds zero standing-text blocks", () => {
  expect(html(<StatusBar segments={[]} />)).toBe("");
  const source = readFileSync("apps/web/src/ui/status-bar/status-bar.tsx", "utf8");
  expect(blocks("apps/web/src/ui/status-bar/status-bar.tsx", source)).toBe(0);
});
