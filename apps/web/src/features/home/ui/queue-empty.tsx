import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { ChangeLine, DDay } from "./change-rows";

type Change = components["schemas"]["OrgChangeSummary"];

// Verbs a quiet day starts from, each listed only for a caller holding its grant (the server still decides).
const TILE = {
  register: { text: "home.tiles.register", to: "/people/new", search: {} },
  import: { text: "home.tiles.import", to: "/people/import", search: {} },
  org: { text: "home.tiles.org", to: "/org", search: {} },
  invite: { text: "home.tiles.invite", to: "/people", search: { view: "accounts" } },
} as const;
export type Tile = keyof typeof TILE;

/**
 * My turn is empty: say so, show what comes due next, and offer the verbs this caller can start. `partial`: some of
 * the queue was refused or failed (named above it), so only what could be read is empty.
 */
export function QueueEmpty({ next, today, tiles, partial = false }: { next: Change[]; today: string; tiles: Tile[]; partial?: boolean }) {
  return (
    <section className="card panel" aria-labelledby="queue-empty">
      <h2 id="queue-empty" className="panel__title" tabIndex={-1}>{t(partial ? "home.empty.partial.title" : "home.empty.title")}</h2>
      <span className="muted">{t(partial ? "home.empty.partial.reason" : "home.empty.reason")}</span>
      {next.length > 0 && (
        <>
          <h3 className="panel__title">{t("home.next.title")}</h3>
          <ul className="list-plain">
            {next.map((c) => (
              <li key={c.id} className="row">
                <ChangeLine c={c} />
                <DDay date={c.effectiveDate} today={today} />
              </li>
            ))}
          </ul>
        </>
      )}
      {tiles.length > 0 && (
        <nav aria-label={t("home.tiles.title")} className="row">
          {tiles.map((k) => (
            <Link key={k} to={TILE[k].to} search={TILE[k].search} className="btn">{t(TILE[k].text)}</Link>
          ))}
        </nav>
      )}
    </section>
  );
}
