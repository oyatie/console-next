// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useLocation, useNavigate } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { Field, TextInput } from "../../../ui/field/field";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { Composer } from "../../../ui/composer/composer";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { freshOnOpen } from "../../../lib/query";
import { PaperSeal } from "../../../ui/paper/paper";
import { PickOne } from "../../../reference/entity/ui/pick-one";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { entityNameText } from "../../../reference/entity/present";
import { entitiesRef } from "../../../reference/entity/api";
import { EmptyState } from "../../../ui/empty-state";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { WorklistSearchField, WorklistSegmentBar } from "../../../ui/patterns/worklist-parts";
import { Table, type Column } from "../../../ui/table";
import { certificatesQuery, certificateSettingsQuery, setCertificateSettings, certificateError, type CertificateSettings } from "../api/certificates";
import s from "./certificate.module.css";
type CertificateSummary = components["schemas"]["CertificatePage"]["items"][number];
const KIND_LABEL = {
  EMPLOYMENT: "empDoc.cert.kind.EMPLOYMENT",
  CAREER: "empDoc.cert.kind.CAREER",
  EXIT: "empDoc.cert.kind.EXIT",
} as const satisfies Record<CertificateSummary["kind"], string>;
const route = getRouteApi("/app/people/certificates");
export function CertificatesPage() {
  const { employee } = route.useSearch();
  const nav = useNavigate();
  const access = useQuery(myAccessQuery);
  const hash = useLocation({ select: (location) => location.hash });
  const canManage = access.isSuccess && access.data?.decisions?.certificate_settings_manage === true;
  const canIssue = access.isSuccess && Array.isArray(access.data?.entries) && accessRefusal(access.data, { domain: "hr_basic", level: "edit" }) === null;
  const configure = hash === "certificate-settings";
  const setConfigure = (open: boolean) => void nav({ search: true, hash: open ? "certificate-settings" : "", replace: true });
  const [qText, setQText] = useState("");
  const [kindFilter, setKindFilter] = useState<"ALL" | CertificateSummary["kind"]>("ALL");
  const q = useInfiniteQuery({ ...certificatesQuery(employee), initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => certificatesQuery(employee, pageParam).queryFn(),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const term = qText.trim().toLowerCase();
  const filtered = items.filter((c) => {
    if (kindFilter !== "ALL" && c.kind !== kindFilter) return false;
    if (!term) return true;
    return c.certificate_no.toLowerCase().includes(term) || c.name.toLowerCase().includes(term) || t(KIND_LABEL[c.kind]).toLowerCase().includes(term);
  });
  const listQ = { ...q, refetch: () => (q.isFetchNextPageError ? q.fetchNextPage() : q.refetch()) };
  const empty = <EmptyState title={t("empDoc.certificate.empty")} reason={t("empDoc.certificate.start")} />;
  const makeColumns = (compact: boolean): Column<CertificateSummary>[] => [
    { header: t("empDoc.certificate.numberLabel"), cell: (c) => c.certificate_no, card: "title" },
    { header: t("empDoc.cert.item.name"), cell: (c) => c.name, card: "fact" },
    { header: t("empDoc.cert.kind"), cell: (c) => t(KIND_LABEL[c.kind] as "empDoc.cert.kind.EMPLOYMENT"), card: "fact" },
    { header: t("empDoc.certificate.issuedAt"), cell: (c) => fmtDateTime(c.issued_at), card: "omit" },
    { header: t("empDoc.certificate.state"), cell: (c) => t(c.voided_at ? "empDoc.certificate.voided" : "empDoc.certificate.issued"), card: "status" },
    ...(compact ? [{
      header: "",
      fit: true,
      card: "action" as const,
      cell: (c: CertificateSummary) => (
        <div className={s.rowAct}>
          <Button size="sm" variant="ghost" onClick={(ev) => { ev.stopPropagation(); void nav({ to: "/people/certificates/$certificateId", params: { certificateId: c.id } }); }}>
            {t("empDoc.certificate.open")}
          </Button>
        </div>
      ),
    }] : []),
  ];
  const table = (compact: boolean) => {
    const inner = (
      <Table
        label={t("empDoc.certificate.register")}
        rows={compact ? filtered : items}
        rowId={(c) => c.id}
        density={compact ? "compact" : undefined}
        mobileLayout={compact ? "compact" : undefined}
        onSelect={(id) => void nav({ to: "/people/certificates/$certificateId", params: { certificateId: id } })}
        columns={makeColumns(compact)}
      />
    );
    return compact ? <div className={s.tableWrap}>{inner}</div> : inner;
  };
  const more = q.hasNextPage ? (
    <Button aria-disabled={q.isFetchingNextPage} onClick={() => { if (!q.isFetchingNextPage) void q.fetchNextPage(); }}>
      {t("empDoc.certificate.more")}
    </Button>
  ) : undefined;
  const settingsBtn = canManage ? (
    <Button id="certificate-settings" size="sm" variant="secondary" onClick={() => setConfigure(!configure)}>
      {t("empDoc.certificate.settings")}
    </Button>
  ) : undefined;
  const settingsModal = configure && canManage ? <Settings onClose={() => setConfigure(false)} /> : undefined;

  const renderBaseline = () => (
    <div className="page">
      <PageHead title={t("empDoc.certificate.register")} crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} />}
        tools={canManage && <Button id="certificate-settings" onClick={() => setConfigure(!configure)}>{t("empDoc.certificate.settings")}</Button>} />
      {employee && <p><Link to="/people/$id" params={{ id: employee }} search={{}}>{t("empDoc.certificate.employee")}</Link> · <Link to="/people/certificates" search={{}}>{t("empDoc.certificate.all")}</Link></p>}
      {settingsModal}
      <Card label={t("empDoc.certificate.register")} flush>
        <QueryState q={listQ} own={certificateError} empty={(d) => d.pages.every((p) => p.items.length === 0) ? empty : null}>
          {() => <>{table(false)}{more}</>}
        </QueryState>
      </Card>
    </div>
  );

  const kindItems = [
    { id: "ALL" as const, label: t("empDoc.certificate.kind.ALL") },
    { id: "EMPLOYMENT" as const, label: t("empDoc.cert.kind.EMPLOYMENT") },
    { id: "CAREER" as const, label: t("empDoc.cert.kind.CAREER") },
    { id: "EXIT" as const, label: t("empDoc.cert.kind.EXIT") },
  ];
  const issueBtn = canIssue ? (
    <Button
      size="sm"
      variant="primary"
      onClick={() => void nav(employee ? { to: "/people/$id", params: { id: employee }, search: {} } : { to: "/people", search: {} })}
    >
      {t("empDoc.certificate.issueAction")}
    </Button>
  ) : undefined;

  return (
    <ExperienceSwitch baseline={renderBaseline}>
      {() => (
        <ListRecord
          q={listQ}
          head={{ title: t("empDoc.certificate.register"), actions: <>{settingsBtn}{issueBtn}</> }}
          views={<WorklistSegmentBar phoneSelect label={t("empDoc.cert.kind")} items={kindItems} value={kindFilter} onChange={setKindFilter} />}
          find={<WorklistSearchField className={s.findField} label={t("empDoc.certificate.find")} value={qText} onChange={setQText} />}
          overlays={settingsModal}
          notes={employee ? <div className={s.bar}><Link to="/people/$id" params={{ id: employee }} search={{}}>{t("empDoc.certificate.employee")}</Link><Link to="/people/certificates" search={{}}>{t("empDoc.certificate.all")}</Link></div> : undefined}
          list={q.data ? (filtered.length === 0 ? empty : table(true)) : null}
          foot={more}
          statusSegments={q.data ? [{ id: "scope", tone: "strong", content: t("empDoc.certificate.register") }, { id: "count", content: t("empDoc.certificate.count", { count: filtered.length }) }] : null}
        />
      )}
    </ExperienceSwitch>
  );
}
function Settings({ onClose }: { onClose: () => void }) {
  const q = freshOnOpen(useQuery({ ...certificateSettingsQuery, retry: false, refetchOnMount: "always" }));
  const entities = useQuery(entitiesRef);
  const [entity, setEntity] = useState<string | null>(null);
  return <QueryState q={q} own={certificateError}>{(d) => <QueryState q={entities}>{(list) => <>
    <SettingsForm key={entity} entity={entity} settings={d.settings.find((row) => row.legal_entity_id === entity) ?? null} maxBytes={d.seal_max_bytes} onClose={onClose}
      picker={<PickOne label={t("placement.entity")} group={t("placement.entity")} empty={t("placement.noMatch")} required options={list.items.filter((e) => e.current).map((e) => ({ value: e.id, label: entityNameText(e), content: <EntityName entity={e} /> }))} value={entity} onChange={setEntity} />} />
  </>}</QueryState>}</QueryState>;
}
function SettingsForm({ entity, settings, maxBytes, onClose, picker }: { entity: string | null; settings: CertificateSettings | null; maxBytes: number; onClose: () => void; picker: ReactNode }) {
  const [prefix, setPrefix] = useState(settings?.prefix ?? "");
  const [width, setWidth] = useState(settings?.width.toString() ?? "");
  const [seal, setSeal] = useState(settings?.seal_text ?? "");
  const [png, setPng] = useState(settings?.seal_png ?? null);
  const [fileError, setFileError] = useState<string | null>(null);
  const save = useCommand({
    run: () => setCertificateSettings({ legal_entity_id: entity!, prefix: prefix.trim(), width: Number(width), seal_text: seal.trim(), seal_png: png, expected_version: settings?.version ?? 0 }),
    invalidates: ["/api/v1/hr/certificate-settings"],
    announce: () => t("empDoc.certificate.saved"),
    onSuccess: onClose,
  });
  const validWidth = Number(width) >= 1 && Number(width) <= 12 && Number.isInteger(Number(width));
  const ready = entity && prefix.trim() && seal.trim() && validWidth;
  return <Composer open action={{ kind: "certificate", mode: "save" }} title={t("empDoc.certificate.settings")} onClose={onClose} pending={save.isSending} locked={save.isChecking}
    consequence={t("empDoc.certificate.settingsEffect")}
    incomplete={!ready} dirty={prefix !== (settings?.prefix ?? "") || width !== (settings?.width.toString() ?? "") || seal !== (settings?.seal_text ?? "") || png !== (settings?.seal_png ?? null)}
    notice={<CommandError error={save.error} own={certificateError} />}
    onSubmit={() => { if (ready && !save.isPending) save.mutate(undefined); }}><div className={s.form}>
    {picker}
    <Field label={t("empDoc.certificate.prefix")} required>{(p) => <TextInput {...p} maxLength={40} value={prefix} onChange={(e) => setPrefix(e.target.value)} />}</Field>
    <Field label={t("empDoc.certificate.width")} required error={width && !validWidth ? t("empDoc.certificate.widthInvalid") : undefined}>{(p) => <TextInput {...p} type="number" min={1} max={12} value={width} onChange={(e) => setWidth(e.target.value)} />}</Field>
    <Field label={t("empDoc.certificate.seal")} required hint={t("empDoc.certificate.sealHelp")}>{(p) => <TextInput {...p} maxLength={200} value={seal} onChange={(e) => setSeal(e.target.value)} />}</Field>
    <FileDrop label={t("empDoc.certificate.sealImage")} accept={[{ mime: "image/png", ext: "PNG" }]} maxBytes={maxBytes} error={fileError} onFiles={([file]) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { if (typeof reader.result === "string") { setPng(reader.result); setFileError(null); } };
      reader.onerror = () => setFileError(t("empDoc.certificate.sealReadFailed"));
      reader.readAsDataURL(file);
    }}>
      {png && <><PaperSeal label={t("empDoc.certificate.sealImage")} image={png} /><Button onClick={() => setPng(null)}>{t("empDoc.certificate.clearSeal")}</Button></>}
    </FileDrop>
  </div></Composer>;
}
