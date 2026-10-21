import { t } from "@console/i18n";

/**
 * Offset paging for a server list; renders nothing when everything fits on one page. A list whose
 * server sends no total passes `more` instead (a full page came back), and shows no range.
 */
export function Pager({ offset, limit, total, more, onPage }: { offset: number; limit: number; total?: number; more?: boolean; onPage: (offset: number) => void }) {
  const next = total === undefined ? Boolean(more) : offset + limit < total;
  if (!next && offset === 0) return null;
  return (
    <nav className="pager" aria-label={t("common.page.label")}>
      {total !== undefined && <span className="muted num">{t("common.page.range", { from: Math.min(total, offset + 1), to: Math.min(total, offset + limit), total })}</span>}
      <button className="btn" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>{t("common.page.prev")}</button>
      <button className="btn" disabled={!next} onClick={() => onPage(offset + limit)}>{t("common.page.next")}</button>
    </nav>
  );
}
