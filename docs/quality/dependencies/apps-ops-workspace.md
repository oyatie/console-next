<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: Register the `@console/ops` workspace (`apps/ops/package.json`) using only the pre-approved React 19 / TanStack / React Aria / Lucide / Vite workspace packages already locked in `package-lock.json` (owner confirmation 2026-11-20), adding zero new external dependencies or version changes.

Provenance: All 8 external packages resolve to the exact tarballs and SHA-512 integrity hashes already verified in `package-lock.json` (`react@19.3.1`, `react-dom@19.3.1`, `@tanstack/react-router@1.170.46`, `@tanstack/react-query@5.105.1`, `react-aria-components@1.22.1`, `lucide-react@1.72.0`, `vite@8.3.8`, `@vitejs/plugin-react@6.3.0`).

| Package | Version | Registry record | Existing job |
| --- | --- | --- | --- |
| react | 19.3.1 | https://registry.npmjs.org/react/19.3.1 | Ops SPA UI renderer |
| react-dom | 19.3.1 | https://registry.npmjs.org/react-dom/19.3.1 | Ops SPA DOM mount |
| @tanstack/react-router | 1.170.46 | https://registry.npmjs.org/%40tanstack%2Freact-router/1.170.46 | Ops SPA routing |
| @tanstack/react-query | 5.105.1 | https://registry.npmjs.org/%40tanstack%2Freact-query/5.105.1 | Ops SPA query state |
| react-aria-components | 1.22.1 | https://registry.npmjs.org/react-aria-components/1.22.1 | Accessible UI primitives |
| lucide-react | 1.72.0 | https://registry.npmjs.org/lucide-react/1.72.0 | Ops SPA icons |
| vite | 8.3.8 | https://registry.npmjs.org/vite/8.3.8 | Ops SPA bundler and preview |
| @vitejs/plugin-react | 6.3.0 | https://registry.npmjs.org/%40vitejs%2Fplugin-react/6.3.0 | Ops SPA React transform |

License: MIT (`react`, `react-dom`, `@tanstack/react-router`, `@tanstack/react-query`, `vite`, `@vitejs/plugin-react`), Apache-2.0 (`react-aria-components`), ISC (`lucide-react`). Identical to existing `apps/web` declarations.

Security: Zero new external packages, zero version changes, and zero install-script additions in `package-lock.json` (only `"apps/ops"` and `"node_modules/@console/ops"` workspace link entries added).
