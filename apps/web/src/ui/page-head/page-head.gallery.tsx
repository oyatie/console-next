import { Download, Plus } from "lucide-react";
import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { Chip } from "../chip";
import { tabClass } from "../tabs/tab-class";
import { TabNav } from "../tabs/tabs";
import { Crumbs } from "./crumbs";
import { PageHead } from "./page-head";
import { PhaseLine } from "./phase-line";

export const order = 127;

/** A list page's head (title, a count line, tools) and a record's band head (crumbs, status, code, route tabs). */
export default function PageHeadGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.pageHead")}</h2>
      <PageHead
        title={tg("pageHead.list")}
        sub={tg("pageHead.sub")}
        meta={<PhaseLine phase="setup">{tg("pageHead.setup")}</PhaseLine>}
        tools={<><Button><Download size={16} aria-hidden />{tg("pageHead.export")}</Button><Button variant="primary"><Plus size={16} aria-hidden />{tg("pageHead.add")}</Button></>}
      />
      <PageHead
        band
        crumbs={<Crumbs items={[<a key="root" href="#structure">{tg("pageHead.crumbRoot")}</a>, <a key="entity" href="#entities">{tg("pageHead.crumbEntity")}</a>]} current={tg("pageHead.title")} />}
        title={tg("pageHead.title")}
        meta={<><PhaseLine phase="operating">{tg("pageHead.operating")}</PhaseLine><Chip tone="info">{tg("pageHead.status")}</Chip><span className="code">{tg("pageHead.code")}</span></>}
        tools={<Button>{tg("pageHead.export")}</Button>}
        tabs={
          <TabNav label={tg("pageHead.title")}>
            <a href="#facts" className={tabClass} aria-current="page">{tg("pageHead.facts")}</a>
            <a href="#places" className={tabClass}>{tg("pageHead.places")}</a>
          </TabNav>
        }
      />
    </section>
  );
}
