import { tg } from "@console/i18n/gallery";
import { Button } from "../../ui/button/button";
import { DisabledReason } from "../../ui/disabled-reason/disabled-reason";
import { Section } from "../Section";

export const order = 990;

/**
 * The link looks (design-language §5.4), as plain anchors with no class: chrome links in a list, a link inside a
 * paragraph and a notice, a remedy beside a reason, and `.link` on a button.
 */
export default function Links() {
  return (
    <Section title={tg("section.links")}>
      <ul className="list-plain">
        <li className="row"><a href="#main">{tg("links.person")}</a><span className="muted">{tg("sample.position")}</span></li>
        <li><a href="#main">{tg("links.all")}</a></li>
      </ul>
      <p>{tg("links.prose")} <a href="#main">{tg("links.proseLink")}</a></p>
      <p className="notice">{tg("links.notice")} <a href="#main">{tg("links.noticeLink")}</a></p>
      <DisabledReason control={(p) => <Button {...p}>{tg("links.blocked")}</Button>} reason={tg("links.blockedWhy")} remedy={<a href="#main">{tg("links.remedy")}</a>} />
      <button type="button" className="link">{tg("links.button")}</button>
    </Section>
  );
}
