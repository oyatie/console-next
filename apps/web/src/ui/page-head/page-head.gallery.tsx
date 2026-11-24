// SPDX-License-Identifier: LicenseRef-Proprietary
import { Download, Plus } from "lucide-react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Button, ToggleButton } from "../button/button";
import { Chip } from "../chip";
import { tabClass } from "../tabs/tab-class";
import { TabNav } from "../tabs/tabs";
import { PageHeadingLevel } from "../page/page-scope";
import { Crumbs } from "./crumbs";
import { PageHead } from "./page-head";
import { PhaseLine } from "./phase-line";

export const order = 127;

/** A list page's head, a command strip with inline filters, and a record's band head with crumbs and route tabs. */
export default function PageHeadGallery() {
  return (
    <PageHeadingLevel value={2}>
      <section className="card gallery__section" data-page-head-gallery>
        <h2 className="toolbar__title">{tg("section.pageHead")}</h2>
        <div data-page-head-demo="list">
          <PageHead
            title={tg("pageHead.list")}
            sub={tg("pageHead.sub")}
            meta={<PhaseLine phase="setup">{tg("pageHead.setup")}</PhaseLine>}
            tools={
              <>
                <Button>
                  <Download size={16} aria-hidden />
                  {tg("pageHead.export")}
                </Button>
                <Button variant="primary">
                  <Plus size={16} aria-hidden />
                  {tg("pageHead.add")}
                </Button>
              </>
            }
          />
        </div>
        <div data-page-head-demo="command">
          <PageHead
            band
            title={t("shell.link.todo")}
            filters={
              <>
                <ToggleButton pressed onClick={() => {}} count={23}>
                  {t("shell.link.todo")}
                </ToggleButton>
                <ToggleButton pressed={false} onClick={() => {}} count={4}>
                  {t("shell.link.approvals")}
                </ToggleButton>
              </>
            }
            tools={<Button>{tg("pageHead.export")}</Button>}
            primary={<Button variant="primary">{tg("pageHead.add")}</Button>}
          />
        </div>
        <div data-page-head-demo="record">
          <PageHead
            band
            crumbs={
              <Crumbs
                items={[
                  <a key="root" href="#structure">
                    {tg("pageHead.crumbRoot")}
                  </a>,
                  <a key="entity" href="#entities">
                    {tg("pageHead.crumbEntity")}
                  </a>,
                ]}
                current={tg("pageHead.title")}
              />
            }
            title={tg("pageHead.title")}
            meta={
              <>
                <PhaseLine phase="operating">{tg("pageHead.operating")}</PhaseLine>
                <Chip tone="info">{tg("pageHead.status")}</Chip>
                <span className="code">{tg("pageHead.code")}</span>
              </>
            }
            tools={<Button>{tg("pageHead.export")}</Button>}
            tabs={
              <TabNav label={tg("pageHead.title")}>
                <a href="#facts" className={tabClass} aria-current="page">
                  {tg("pageHead.facts")}
                </a>
                <a href="#places" className={tabClass}>
                  {tg("pageHead.places")}
                </a>
              </TabNav>
            }
          />
        </div>
      </section>
    </PageHeadingLevel>
  );
}
