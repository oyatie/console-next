// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, useRouterState } from "@tanstack/react-router";
import { loadCatalog } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import "../../../app.css";

await loadCatalog("ko");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
// Loaded with its first use, as the shell loads it.
const JumpPalette = lazy(() => import("./jump-palette").then(m => ({ default: m.JumpPalette })));

/** The shell's wiring of the jump palette: closed at load, opened by Ctrl/Cmd+K or by the search button. */
export function Fixture() {
  const [jump, setJump] = useState(false);
  const at = useRouterState({ select: s => s.location.href });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
        e.preventDefault();
        setJump(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <main>
      <p>Jump palette fixture</p>
      <Button onClick={() => setJump(true)}>Search</Button>
      <output aria-label="Location">{at}</output>
      {jump && (
        <Suspense fallback={null}>
          <JumpPalette onClose={() => setJump(false)} />
        </Suspense>
      )}
    </main>
  );
}

const router = createRouter({ routeTree: createRootRoute({ component: Fixture }), history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
