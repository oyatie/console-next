import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { Banner } from "./banner";

export const order = 125;

/** Every tone, with and without a title and actions; the page strip for a past as-of date. */
export default function BannerGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.banner")}</h2>
      <Banner tone="info">{tg("banner.info")}</Banner>
      <Banner tone="warn" title={tg("banner.warnTitle")}>{tg("banner.warn")}</Banner>
      <Banner tone="danger" actions={<Button size="sm">{tg("banner.fix")}</Button>}>{tg("banner.danger")}</Banner>
      <Banner tone="ok" live="polite">{tg("banner.ok")}</Banner>
      <Banner tone="past" placement="page" actions={<Button size="sm">{tg("banner.today")}</Button>}>{tg("banner.past")}</Banner>
    </section>
  );
}
