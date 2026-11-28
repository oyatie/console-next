// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, ApiError, unwrap } from "@console/api";
import type { CatalogCommand } from "./domain/catalog-draft";
import { get } from "../../lib/query";

export const PAGE_SIZE = 25;
export const views = ["frameworks", "regulations", "obligations", "controls"] as const;
export type View = typeof views[number];

const paths = {
  framework: "/api/v1/compliance/frameworks", regulation: "/api/v1/compliance/regulations",
  obligation: "/api/v1/compliance/obligations", control: "/api/v1/compliance/framework-controls",
  regulationLink: "/api/v1/compliance/obligation-regulation-links", coverage: "/api/v1/compliance/control-obligation-coverage",
} as const;
export const catalogPaths = Object.values(paths);
const pageQuery = (page: number, q?: string) => ({ offset: page * PAGE_SIZE, limit: PAGE_SIZE, q: q || undefined });
export const frameworksQuery = (page: number, q?: string) => get(paths.framework, { params: { query: pageQuery(page, q) } });
export const regulationsQuery = (page: number, q?: string) => get(paths.regulation, { params: { query: pageQuery(page, q) } });
export const obligationsQuery = (page: number, branch?: string, q?: string) => get(paths.obligation, { params: { query: { ...pageQuery(page, q), branch_id: branch } } });
export const controlsQuery = (page: number, framework: string, q?: string) => get(paths.control, { params: { query: { ...pageQuery(page, q), framework_id: framework } } });

export async function saveCatalog(command: CatalogCommand, key: string) {
  const params = { header: { "Idempotency-Key": key } };
  try {
    switch (command.action) {
      case "framework": return await unwrap(api.POST(paths.framework, { params, body: command.body }));
      case "regulation": return await unwrap(api.POST(paths.regulation, { params, body: command.body }));
      case "obligation": return await unwrap(api.POST(paths.obligation, { params, body: command.body }));
      case "control": return await unwrap(api.POST(paths.control, { params, body: command.body }));
      case "regulationLink": return await unwrap(api.POST(paths.regulationLink, { params, body: command.body }));
      case "coverage": return await unwrap(api.POST(paths.coverage, { params, body: command.body }));
    }
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409 && error.code === "command_applied")) throw error;
    return null;
  }
}
