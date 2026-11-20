// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { blocks } from "../../../../../scripts/check-standing-text.mjs";
import { Ledger, type LedgerProps, type LedgerRow, type LedgerRowTone, type LedgerTotalKind, type LedgerTotalRow } from "./index";

beforeAll(() => loadCatalog("ko"));

test("Ledger renders semantic table sections, sr-only headers, detail column, and totals", () => {
  const rows: LedgerRow[] = [
    { key: "base", label: "Base pay", amount: "3,100,000", numericValue: 3100000 },
    { key: "ot", label: "Overtime", detail: "Approved 12h", amount: "267,000", numericValue: 267000 },
    { key: "adj", label: "Adjustment", amount: "-50,000", numericValue: -50000, tone: "negative" },
    { key: "bonus", label: "Bonus", amount: "0", numericValue: 0, tone: "zero" },
    { key: "memo", label: "Note line", amount: "100,000", tone: "muted" },
  ];
  const totals: LedgerTotalRow[] = [
    { key: "sub", label: "Subtotal", amount: "3,317,000", numericValue: 3317000, kind: "subtotal" },
    { key: "gross", label: "Gross pay", amount: "3,417,000", numericValue: 3417000, kind: "total" },
    { key: "taxable", label: "Taxable", detail: "Gross - exempt", amount: "3,217,000", kind: "note" },
  ];
  const tone: LedgerRowTone = "negative";
  const kind: LedgerTotalKind = "note";
  const props: LedgerProps = {
    title: "Earnings",
    titleId: "earnings-head",
    level: 2,
    headerTag: "Draft",
    unit: "KRW",
    headerSurface: "surface",
    detailLayout: "column",
    rows,
    totals,
    footnote: "Calculated from approved hours.",
  };

  const out = html(<Ledger {...props} />);
  expect(tone).toBe("negative");
  expect(kind).toBe("note");
  expect(out).toContain("<section");
  expect(out).toContain('data-ledger=""');
  expect(out).toContain('data-header-surface="surface"');
  expect(out).toContain('data-detail-layout="column"');
  expect(out).toContain('<h2 id="earnings-head"');
  expect(out).toContain('tabindex="-1"');
  expect(out).toContain("Draft");
  expect(out).toContain("KRW");
  expect(out).toContain("<table");
  expect(out).toContain('data-has-detail="true"');
  expect(out).toContain(`<th scope="col">${t("uiLedger.colItem")}</th>`);
  expect(out).toContain(`<th scope="col">${t("uiLedger.colDetail")}</th>`);
  expect(out).toContain(`<th scope="col">${t("uiLedger.colAmount")}</th>`);
  expect(out).toContain('<data value="3100000"');
  expect(out).toContain('data-tone="negative"');
  expect(out).toContain('data-tone="zero"');
  expect(out).toContain('data-tone="muted"');
  expect(out).toContain("<tfoot>");
  expect(out).toContain('data-kind="subtotal"');
  expect(out).toContain('data-kind="total"');
  expect(out).toContain('data-kind="note"');
  expect(out).toContain("Calculated from approved hours.");
});

test("Ledger inline detailLayout collapses to two columns and supports custom column headers", () => {
  const out = html(
    <Ledger
      label="Deductions"
      headerSurface="muted"
      detailLayout="inline"
      columns={{ item: "Deduction", amount: "Won" }}
      rows={[{ key: "tax", label: "Income tax", detail: "Simplified table", amount: "98,740" }]}
      totals={[{ key: "tot", label: "Total deductions", detail: "6 items", amount: "425,245" }]}
    />,
  );
  expect(out).toContain('aria-label="Deductions"');
  expect(out).toContain('data-header-surface="muted"');
  expect(out).toContain('data-detail-layout="inline"');
  expect(out).not.toContain('data-has-detail="true"');
  expect(out).toContain('<th scope="col">Deduction</th>');
  expect(out).toContain('<th scope="col">Won</th>');
  expect(out).not.toContain(`<th scope="col">${t("uiLedger.colDetail")}</th>`);
  expect(out).toContain("Simplified table");
  expect(out).toContain("6 items");
});

test("Ledger renders loading, empty, and error states outside <table>", () => {
  const loadingOut = html(<Ledger title="Pay" loading rows={[]} footnote="Should hide" />);
  expect(loadingOut).toContain('aria-busy="true"');
  expect(loadingOut).toContain('role="status"');
  expect(loadingOut).not.toContain("<table");
  expect(loadingOut).not.toContain("Should hide");

  const emptyOut = html(<Ledger title="Pay" rows={[]} empty="No ledger lines" footnote="Footer kept" />);
  expect(emptyOut).toContain("No ledger lines");
  expect(emptyOut).toContain("Footer kept");
  expect(emptyOut).not.toContain("<table");

  const errorOut = html(<Ledger title="Pay" rows={[{ key: "a", label: "A", amount: "1" }]} error="Failed to load" footnote="Should hide" />);
  expect(errorOut).toContain('role="alert"');
  expect(errorOut).toContain("Failed to load");
  expect(errorOut).not.toContain("<table");
  expect(errorOut).not.toContain("Should hide");

  const loadingAndErrorOut = html(<Ledger title="Pay" loading error="Gateway timeout" rows={[]} />);
  expect(loadingAndErrorOut).toContain('role="alert"');
  expect(loadingAndErrorOut).toContain("Gateway timeout");
  expect(loadingAndErrorOut).not.toContain('aria-busy="true"');
});

test("Ledger contributes 0 standing-text blocks", () => {
  const ledgerPath = resolve("apps/web/src/ui/ledger/ledger.tsx");
  const source = readFileSync(ledgerPath, "utf8");
  expect(blocks(ledgerPath, source)).toBe(0);
});
