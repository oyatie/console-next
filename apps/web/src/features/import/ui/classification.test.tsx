// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { IMPORT_CLASSIFICATION } from "../../../lib/labels";
import type { ImportPreview } from "../domain/contract";
import { initialPicks } from "../domain/steps";
import { PreviewStep } from "./preview-step";

beforeAll(() => loadCatalog("ko"));
const noop = () => undefined;
const preview: ImportPreview = {
  run_id: "classification", entity_type: "employee_hr", source_filename: "synthetic.xlsx", source_sha256: "a".repeat(64),
  input_rows: 1, candidate_rows: 1, preserved_rows: 0, sealed_identities: 0,
  columns: IMPORT_CLASSIFICATION.values.map(classification => ({ source_header: classification, normalized_header: classification, classification, preview_allowed: false })),
  sample_rows: [], mapping_profile: {}, sheets: [], sheets_needing_mapping: 0, available_targets: [],
};

test("classification effects read tones from the registry while retaining their contextual words", () => {
  const tones = IMPORT_CLASSIFICATION.tone!;
  const original = tones.restricted;
  const client = new QueryClient();
  try {
    tones.restricted = "danger";
    const out = renderToStaticMarkup(<QueryClientProvider client={client}>
      <PreviewStep preview={preview} picks={initialPicks()} mapping={{}} rereading={false} onRemap={noop} onDryRun={noop} onExpired={noop} onRestart={noop} />
    </QueryClientProvider>);
    expect(out).toContain('<span class="chip chip--danger">저장하지 않음</span>');
    expect(out).toContain('<span class="chip chip--ok">직원 정보로 반영</span>');
    expect(out).toContain('<span class="chip chip--neutral">원본만 보관</span>');
    expect(out).toContain('<span class="chip chip--info">위치 정보(가림)</span>');
  } finally {
    tones.restricted = original;
    client.clear();
  }
});
