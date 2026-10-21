import { SectionHead } from "../../../ui/card/section-head";
import { buttonClass } from "../../../ui/button/button-class";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { saveFile } from "../../../lib/download";
import { Button } from "../../../ui/button/button";
import { SelectField } from "../../../ui/select/select-field";
import { RecordRows } from "../../../ui/record/rows";
import { EmptyState } from "../../../ui/empty-state";
import { Receipt } from "../../../ui/receipt/receipt";
import { Chip } from "../../../ui/chip";
import { EXPORT_PURPOSES } from "../../../reference/directory/domain/export";
import { exportRegister, registerQuery, type RegisterPage } from "../../../reference/statutory/api";
import s from "./statutory.module.css";
import { registerPrintHtml } from "./register-print";

const FIELD: Record<string, { label: "name" | "sex" | "birth" | "address" | "job" | "contract" | "history" | "exit"; act?: string; hash?: string }> = {
  name: { label: "name", act: "fix:name" }, sex: { label: "sex", act: "fix:sex" },
  birth: { label: "birth", act: "fix:birth_date" }, address: { label: "address", act: "fix:address" },
  job: { label: "job", act: "fix:job" }, hire: { label: "contract", act: "fix:hire_date" }, contract: { label: "contract", hash: "s5" },
  history: { label: "history", hash: "s5" }, exit: { label: "exit", hash: "s1" },
};

export function WorkerRegister({ site, date }: { site: string; date: string }) {
  const [after, setAfter] = useState<string>();
  const [purpose, setPurpose] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [exported, setExported] = useState(false);
  const page = useQuery(registerQuery(site, date, after));
  const run = useCommand({
    run: (format: "xlsx" | "pdf") => exportRegister(site, date, format, purpose!),
    onSuccess: async (file) => {
      if (file instanceof Blob) saveFile(file, t("statutory.file", { site: page.data?.workplace_name ?? "", date }));
      else printRegister(file);
      setExported(true);
    },
  });
  const download = (format: "xlsx" | "pdf") => { setTried(true); if (purpose) run.mutate(format); };
  return <QueryState q={page}>{(data) => <>
    <div className="row"><SectionHead level={2}>{data.workplace_name}</SectionHead><Chip>{t("statutory.people", { count: data.total })}</Chip></div>
    <div className="row">
      <SelectField label={t("statutory.purpose")} placeholder={t("statutory.pickPurpose")} value={purpose} onChange={setPurpose}
        options={EXPORT_PURPOSES.map((p) => ({ id: p, label: t(`roster.export.purpose.${p}`) }))}
        error={tried && !purpose ? t("roster.export.purpose.pick") : undefined} />
      <Button onClick={() => download("xlsx")} disabled={run.isPending}>{t("statutory.xlsx")}</Button>
      <Button onClick={() => download("pdf")} disabled={run.isPending}>{t("statutory.pdf")}</Button>
    </div>
    <CommandError error={run.error} />
    {data.items.length ? (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to scroll this wide table.
        <div className={s.scroll} tabIndex={0} role="region" aria-label={t("statutory.register")}><RecordRows label={t("statutory.register")} rows={data.items} rowId={(r) => r.employee_id}
      columns={[
        ...data.headers.map((header, i) => ({ header, cell: (r: typeof data.items[number]) => i === 1 ? <Link to="/people/$id" params={{ id: r.employee_id }}>{r.cells[i]}</Link> : r.cells[i] || "—" })),
        { header: t("statutory.missing"), cell: (r) => <ul className="list-plain">{r.missing.map((key) => { const field = FIELD[key]; return <li key={key}><Link to="/people/$id" params={{ id: r.employee_id }} search={{ act: field?.act }} hash={field?.hash}>
          {t("statutory.missingField", { name: r.cells[1], field: field ? t(`empCard.reg.item.${field.label}`) : key })}
        </Link></li>; })}</ul> },
      ]} /></div>) : <EmptyState title={t("statutory.noWorkers")} reason={t("statutory.noWorkersReason")} actions={<Link to="/people" className={buttonClass()}>{t("statutory.openPeople")}</Link>} />}
    <div className="row">{after && <Button onClick={() => setAfter(undefined)}>{t("common.back")}</Button>}{data.next && <Button onClick={() => setAfter(data.next!)}>{t("statutory.more")}</Button>}</div>
    {exported && <Receipt placement="docked" state="applied" message={t("statutory.exported", { count: data.total })} onDismiss={() => setExported(false)} />}
  </>}</QueryState>;
}

function printRegister(page: RegisterPage) {
  const frame = document.createElement("iframe");
  frame.className = "sr-only";
  frame.setAttribute("aria-hidden", "true");
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  };
  frame.srcdoc = registerPrintHtml(page);
  document.body.append(frame);
}
