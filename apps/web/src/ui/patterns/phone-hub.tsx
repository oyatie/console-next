// SPDX-License-Identifier: LicenseRef-Proprietary
import { ChevronRight } from "lucide-react";
import { shown } from "../shown";
import { PatternShell } from "./pattern-shell";
import type { PhoneHubLinkItem, PhoneHubProps } from "./phone-hub-contract";
import s from "./phone-hub.module.css";

/**
 * PhoneHub (`P12`) arrangement: phone-first single-column hub with `identity`, flush `stats`,
 * full-width `links`, and `--surface-2`-headed `sections`.
 */
export function PhoneHub({
  q,
  head,
  tabs,
  identity,
  stats,
  links,
  renderLink,
  notes,
  sections,
  foot,
  facts: _facts,
  overlays,
  statusSegments,
  baseline,
}: PhoneHubProps) {
  const renderLinkItem = (item: PhoneHubLinkItem) => {
    const content = (
      <>
        {item.icon ? <div className={s.linkIcon}>{item.icon}</div> : null}
        <bdi className={s.linkLabel}>{item.label}</bdi>
        {item.meta != null ? <bdi className={s.linkMeta}>{item.meta}</bdi> : null}
        <ChevronRight size={16} aria-hidden="true" className={s.linkChev} />
      </>
    );
    if (renderLink) return renderLink(item, content, s.linkRow!);
    if (item.href) {
      return (
        <a
          href={item.href}
          className={s.linkRow}
          onClick={
            item.onPress
              ? event => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  item.onPress?.();
                }
              : undefined
          }
        >
          {content}
        </a>
      );
    }
    return (
      <button type="button" className={s.linkRow} onClick={item.onPress}>
        {content}
      </button>
    );
  };

  return (
    <PatternShell
      pattern="phone-hub"
      floorplan="P-05"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="record"
      phoneHeadAware
      statusSegments={statusSegments}
      baseline={baseline}
    >
      {() => (
        <div className={s.column}>
          {shown(identity) ? <div className={s.identity}>{identity}</div> : null}
          {shown(stats) ? <div className={s.stats}>{stats}</div> : null}
          {links && links.length > 0 ? (
            <ul className={s.links}>
              {links.map(item => (
                <li key={item.key} className={s.linkEntry}>
                  {renderLinkItem(item)}
                </li>
              ))}
            </ul>
          ) : null}
          {notes}
          {sections.map(section => {
            const headingId = section.titleId ?? `hub-sec-${section.key}`;
            return (
              <section key={section.key} className={s.section} aria-labelledby={headingId}>
                <header className={s.sectionHead}>
                  <h2 id={headingId} className={s.sectionTitle}>
                    {section.title}
                  </h2>
                  {section.action != null ? <div className={s.sectionAction}>{section.action}</div> : null}
                </header>
                <div className={s.sectionBody}>{section.children}</div>
              </section>
            );
          })}
          {foot}
        </div>
      )}
    </PatternShell>
  );
}
