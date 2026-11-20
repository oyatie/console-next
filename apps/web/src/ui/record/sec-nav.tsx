import { t } from "@console/i18n";
import s from "./record.module.css";
import { Kbd } from "./record-section";

/**
 * The record's section chips: number key, title and count; the current one is marked. A chip is an in-page link to
 * its section. `no` is the section's own number and the digit the screen binds to it: the key cap shows it, so a chip
 * keeps its key when a section before it is not listed.
 */
export function SecNav({ items, current, onJump }: { items: { id: string; no: number; title: string; count?: number }[]; current: string; onJump: (id: string) => void }) {
  return (
    <nav className={s.secnav} aria-label={t("uiRecord.sections")}>
      {items.map((x) => (
        <a
          key={x.id}
          href={`#${x.id}`}
          aria-current={x.id === current || undefined}
          onClick={(e) => {
            e.preventDefault();
            onJump(x.id);
          }}
        >
          <Kbd k={String(x.no)} />
          {x.title}
          {x.count != null && <span className={s.count}>{x.count}</span>}
        </a>
      ))}
    </nav>
  );
}
