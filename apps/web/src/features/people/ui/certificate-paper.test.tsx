// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "@console/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { CertificatePaper } from "./certificate-paper";
import type { Certificate } from "../api/certificates";

beforeAll(() => loadCatalog("ko"));

const certificate: Certificate = {
  id: "certificate", employee_id: "employee", certificate_no: "TEST-2026-000001", kind: "EMPLOYMENT", items: ["period"], purpose: "제출용", replaces_id: null,
  issued_by: "issuer", issued_at: "2026-10-21T00:00:00Z", voided_at: null, void_reason: null,
  snapshot: { name: "정하늘", issuer: "시험 법인", seal_text: "시험 법인 대표", period: { from: "2020-01-02", to: "2026-10-21" }, birth: "1990-06-01", wage: { won: "1234567", unit: "MONTH" } },
};
describe("issued certificate paper", () => {
  it("prints the frozen identity, number and only explicitly requested fields", () => {
    const html = renderToStaticMarkup(<CertificatePaper certificate={certificate} />);
    expect(html).toContain("정하늘"); expect(html).toContain("TEST-2026-000001"); expect(html).toContain("시험 법인 대표");
    expect(html).toContain("2020"); expect(html).not.toContain("1990"); expect(html).not.toContain("1234567");
  });
  it("marks a voided certificate on the document itself", () => {
    const html = renderToStaticMarkup(<CertificatePaper certificate={{ ...certificate, voided_at: "2026-10-21T01:00:00Z", void_reason: "기재 내용 정정" }} />);
    expect(html).toContain("무효"); expect(html).toContain("기재 내용 정정");
  });
});

it("prints the issued seal image from the frozen snapshot", () => {
  const seal_png = "data:image/png;base64,iVBORw0KGgo=";
  const html = renderToStaticMarkup(<CertificatePaper certificate={{ ...certificate, snapshot: { ...certificate.snapshot, seal_png } }} />);
  expect(html).toContain(seal_png);
});

it("uses the paper's printable seal and void slots without standing instructions", () => {
  const html = renderToStaticMarkup(<CertificatePaper certificate={{ ...certificate, voided_at: "2026-10-21T01:00:00Z", void_reason: "기재 내용 정정" }} />);
  expect(html).toContain("data-paper-seal");
  expect(html).toContain("data-paper-void");
  expect(html).not.toContain("발급 당시");
});
