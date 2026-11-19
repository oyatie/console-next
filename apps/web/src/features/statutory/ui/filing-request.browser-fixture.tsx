// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import { filingTask } from "../../../../../../e2e/mock/filings";
import { FilingRequest } from "./filing-request";
import "../../../app.css";

await loadCatalog("ko");

export const Fixture = () => <QueryClientProvider client={new QueryClient()}><FilingRequest task={filingTask} onClose={() => {}} /></QueryClientProvider>;
createRoot(document.getElementById("root")!).render(<Fixture />);
