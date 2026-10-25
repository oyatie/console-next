// SPDX-License-Identifier: LicenseRef-Proprietary
import type { DepOptimizationOptions } from "vite";
export { chromium, type Browser, type Page } from "@playwright/test";

// Virtual fixtures evade Vite's scanner; prebundle their shared dependencies before the browser loads React.
export const browserTestOptimizeDeps: DepOptimizationOptions = {
  include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@tanstack/react-query", "@tanstack/react-router", "intl-messageformat", "lucide-react", "openapi-fetch", "react-aria-components"],
};
