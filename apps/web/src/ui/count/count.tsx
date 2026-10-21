import { fmtNumber } from "@console/i18n/format";
import css from "./count.module.css";

/**
 * A filter chip's server count: the number, "—" (with why, `failed`) when the read failed, or a bar while it loads.
 * All three take one width, so the chips beside it stay put when the count lands: a click already on its way to
 * one of them would otherwise release on the gap it slid out of.
 */
export function Count({ n, failed }: { n: number | undefined; failed?: string }) {
  if (n !== undefined) return <span className={css.count}>{fmtNumber(n)}</span>;
  if (failed) return <span className={css.count} title={failed}>—</span>;
  return <span className={`${css.count} ${css.pending}`} aria-hidden="true" />;
}
