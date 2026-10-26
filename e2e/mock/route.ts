// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page, Request } from "@playwright/test";
import type { components, paths } from "@console/api";

type Method = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";
type Methods<P extends keyof paths> = { [M in Method]: paths[P][M] extends { responses: object } ? M : never }[Method];
type Responses<P extends keyof paths, M extends Methods<P>> = paths[P][M] extends { responses: infer R } ? R : never;
type Json<R> = R extends { content: { "application/json": infer J } } ? J : never;
type Reply<P extends keyof paths, M extends Methods<P> = Methods<P>> = {
  [S in keyof Responses<P, M> & number]: { status: S; json: Json<Responses<P, M>[S]> }
}[keyof Responses<P, M> & number] |
  // Middleware can refuse or shed any operation, using the generated common error envelope.
  { status: 403 | 503; json: components["schemas"]["ErrorBody"] };

/** JSON routes from the generated API contract. Query strings reach factories unchanged. */
export async function mockRoute<P extends keyof paths, M extends Methods<P>>(
  page: Page, method: M, path: P,
  reply: Reply<NoInfer<P>, NoInfer<M>> | ((request: Request) => Reply<NoInfer<P>, NoInfer<M>> | Promise<Reply<NoInfer<P>, NoInfer<M>>>),
) {
  const parts = path.split("/");
  await page.route(url => {
    const actual = url.pathname.split("/");
    return actual.length === parts.length && parts.every((part, i) => /^\{[^}]+\}$/.test(part) ? Boolean(actual[i]) : part === actual[i]);
  }, async route => {
    if (route.request().method().toLowerCase() !== method) return route.fallback();
    const response = typeof reply === "function" ? await reply(route.request()) : reply;
    if (!page.isClosed()) await route.fulfill(response);
  });
}
