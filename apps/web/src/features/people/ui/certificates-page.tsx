// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCan } from "../../../reference/authz/ui/use-can";
import { QueryState } from "../../../lib/react/query-state";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { Field, TextInput } from "../../../ui/field/field";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { Sheet } from "../../../ui/sheet/sheet";
import { PaperSeal } from "../../../ui/paper/paper";
import { PickOne } from "../../../reference/entity/ui/pick-one";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { entityNameText } from "../../../reference/entity/present";
import { entitiesRef } from "../../../reference/entity/api";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { certificatesQuery, certificateSettingsQuery, setCertificateSettings, certificateError, type CertificateSettings } from "../api/certificates";
import s from "./certificate.module.css";
const route = getRouteApi("/app/people/certificates");
export function CertificatesPage() {
  const { employee } = route.useSearch();
  const nav = useNavigate();
  const can = useCan();
  const [configure, setConfigure] = useState(false);
  const q = useInfiniteQuery({ ...certificatesQuery(employee), initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => certificatesQuery(employee, pageParam).queryFn(),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  return <div className="page">
    <PageHead title={t("empDoc.certificate.register")} crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} />}
      tools={can("org_change_apply", "all") && <Button onClick={() => setConfigure(!configure)}>{t("empDoc.certificate.settings")}</Button>} />
    {employee && <p><Link to="/people/$id" params={{ id: employee }} search={{}}>{t("empDoc.certificate.employee")}</Link> · <Link to="/people/certificates" search={{}}>{t("empDoc.certificate.all")}</Link></p>}
    {configure && <Settings onClose={() => setConfigure(false)} />}
    <Card label={t("empDoc.certificate.register")} flush>
      <QueryState q={{ ...q, refetch: () => q.isFetchNextPageError ? q.fetchNextPage() : q.refetch() }} own={certificateError} empty={(d) => d.pages.every((p) => p.items.length === 0) ? <EmptyState title={t("empDoc.certificate.empty")} reason={t("empDoc.certificate.start")} /> : null}>
        {(d) => <><Table label={t("empDoc.certificate.register")} rows={d.pages.flatMap((p) => p.items)} rowId={(c) => c.id}
          onSelect={(id) => void nav({ to: "/people/certificates/$certificateId", params: { certificateId: id } })}
          columns={[
            { header: t("empDoc.certificate.numberLabel"), cell: (c) => c.certificate_no },
            { header: t("empDoc.cert.item.name"), cell: (c) => c.name },
            { header: t("empDoc.cert.kind"), cell: (c) => t(`empDoc.cert.kind.${c.kind}`) },
            { header: t("empDoc.certificate.issuedAt"), cell: (c) => fmtDateTime(c.issued_at) },
            { header: t("empDoc.certificate.state"), cell: (c) => t(c.voided_at ? "empDoc.certificate.voided" : "empDoc.certificate.issued") },
          ]} />
          {q.hasNextPage && <Button aria-disabled={q.isFetchingNextPage} onClick={() => { if (!q.isFetchingNextPage) void q.fetchNextPage(); }}>{t("empDoc.certificate.more")}</Button>}
        </>}
      </QueryState>
    </Card>
  </div>;
}
function Settings({ onClose }: { onClose: () => void }) {
  const q = useQuery(certificateSettingsQuery);
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
  });
  const ready = entity && prefix.trim() && seal.trim() && Number(width) >= 1 && Number(width) <= 12 && Number.isInteger(Number(width));
  return <Sheet open title={t("empDoc.certificate.settings")} onClose={onClose} pending={save.isSending} locked={save.isChecking}
    consequence={t("empDoc.certificate.sealHelp")}
    notice={<CommandError error={save.error} own={certificateError} />}
    actions={<><Button variant="primary" aria-disabled={!ready || save.isPending} onClick={() => { if (ready && !save.isPending) save.mutate(undefined); }}>{t("empDoc.certificate.save")}</Button></>}><div className={s.form}>
    {picker}
    <Field label={t("empDoc.certificate.prefix")} required>{(p) => <TextInput {...p} maxLength={40} value={prefix} onChange={(e) => setPrefix(e.target.value)} />}</Field>
    <Field label={t("empDoc.certificate.width")} required>{(p) => <TextInput {...p} type="number" min={1} max={12} value={width} onChange={(e) => setWidth(e.target.value)} />}</Field>
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
    {save.isSuccess && <p role="status">{t("empDoc.certificate.saved")}</p>}
  </div></Sheet>;
}
