// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "../../../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import type { ComponentProps, ReactNode } from "react";
import { CertificateSheet } from "./certificate-sheet";

const permission = vi.hoisted(() => ({ isSuccess: false, isFetchedAfterMount: true }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => permission }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {}, Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ error: new ApiError(422, "certificate_settings_required", "", []), isPending: false }) }));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("./card-who", () => ({ Who: () => null }));
beforeAll(() => loadCatalog("ko"));

test.each([[false, true], [true, true], [true, false]])("settings remedy uses a fresh server Cedar decision: %s %s", (allowed, fresh) => {
  permission.isSuccess = allowed;
  permission.isFetchedAfterMount = fresh;
  const c = { e: { id: "person", status: "ACTIVE" }, place: { entity: "회사" } } as ComponentProps<typeof CertificateSheet>["c"];
  const markup = renderToStaticMarkup(<CertificateSheet c={c} onClose={() => {}} />);
  expect(markup.includes(t("empDoc.certificate.settings"))).toBe(allowed && fresh);
});
