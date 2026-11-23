// SPDX-License-Identifier: LicenseRef-Proprietary
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { opsQueryClient } from "./lib/runtime";
import { createOpsRouter } from "./router";

const router = createOpsRouter();

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <QueryClientProvider client={opsQueryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
