// Company domain: a platform-assigned label with permanently reserved aliases.

/** The server's pattern: a lowercase letter or digit, then lowercase letters, digits or hyphens. */
import { validCompanyDomain } from "../../../lib/pure/company-domain";

/** Typed text as a slug: lower-cased as the user types (the server stores it as given). */
export const asSlug = (typed: string) => typed.toLowerCase();

/** Why this slug cannot be used: its shape, or an existing tenant already holding it (a fact, so it blocks). */
export type SlugProblem = { kind: "pattern" } | { kind: "taken"; org: string } | null;
export function slugProblem(slug: string, existing: readonly { slug: string; name: string; domain_aliases?: readonly string[] }[]): SlugProblem {
  const s = slug.trim();
  if (!validCompanyDomain(s)) return { kind: "pattern" };
  const owner = existing.find((o) => (o.slug === s || o.domain_aliases?.includes(s)));
  return owner ? { kind: "taken", org: owner.name } : null;
}

/**
 * The tenant a lost onboarding response opened: the one now holding the exact slug that was sent, unknown before it
 * was sent. Never matched by name (names repeat across tenants); onboarding takes no Idempotency-Key (BW-25), so the
 * slug, unique on the server, is the only key.
 */
export const openedBy = <O extends { id: string; slug: string }>(all: readonly O[], slug: string, known: ReadonlySet<string>) =>
  all.find((o) => o.slug === slug && !known.has(o.id));

/** Only the parsed host of a reference supplied by the tenant can suggest a label. */
export function suggestedDomain(host: string | null): string | null {
  if (!host?.includes(".")) return null;
  const label = host.toLowerCase().replace(/^www\./, "").split(".")[0]!;
  return validCompanyDomain(label) ? label : null;
}
