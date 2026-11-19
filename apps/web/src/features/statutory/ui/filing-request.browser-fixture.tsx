// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import type { FilingTask } from "../../../reference/statutory/api";
import { FilingRequest } from "./filing-request";
import "../../../app.css";

await loadCatalog("ko");
// The dialog reads the event, the person's name and the kind of filing; nothing is sent until a kind and a date are both given.
const task = { event_id: "event", name: "Kim", kind: "ACQUIRE" } as FilingTask;

export const Fixture = () => <QueryClientProvider client={new QueryClient()}><FilingRequest task={task} onClose={() => {}} /></QueryClientProvider>;
createRoot(document.getElementById("root")!).render(<Fixture />);
