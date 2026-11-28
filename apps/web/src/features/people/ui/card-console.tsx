// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { focusSoon } from "../../../lib/react/announce";
import { usePageActive } from "../../../lib/react/page-active";
import type { ReadState } from "../../../lib/react/query-view";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { operationAccess } from "../../../reference/authz/domain/operation-access";
import { useDocumentsServed } from "../../../reference/authz/ui/use-documents-served";
import { RecordPattern } from "../../../ui/patterns/record";
import { certificatesQuery } from "../api/certificates";
import { CardSkeleton } from "./card-states";
import { LoadedConsoleCard } from "./card-console-loaded";
import type { CardTab } from "./card-head";
import type { ContractEdit } from "./contracts-card";
import type { Done } from "./person-act";
import { useCard } from "./use-card";
import { useCardRefusal } from "./use-card-refusal";

const CardPrint = lazy(() => chunk(import("./card-print")).then(m => ({ default: m.CardPrint })));

type Detail = components["schemas"]["EmployeeDetail"];
const route = getRouteApi("/app/people/$id");

export function CardConsole({
  id,
  detail,
  loading,
  opened,
  baseline,
}: {
  id: string;
  detail: ReadState<Detail>;
  loading: boolean;
  opened: string | null;
  baseline: () => React.ReactNode;
}) {
  const { act, back, tab: requestedTab = "card" } = route.useSearch();
  const navigate = route.useNavigate();
  const documents = useDocumentsServed();
  const access = useQuery(myAccessQuery);
  const canCerts = Boolean(access.data && accessRefusal(access.data, operationAccess["GET /api/v1/hr/certificates"]) === null);
  const { refused, refusedNow, latchedRefusal } = useCardRefusal(detail);
  const certs = useQuery({ ...certificatesQuery(id), enabled: canCerts && Boolean(detail.data) && !refused, retry: false });

  const d = refused ? undefined : detail.data;
  const coldWait = !detail.error && !refused && (detail.isPending || (opened !== id && loading));
  const patternQ: ReadState = coldWait
    ? { ...detail, isPending: true, data: undefined }
    : refused && !refusedNow
      ? { ...detail, error: latchedRefusal }
      : detail;

  if (act === "print" && d && !coldWait) {
    return (
      <ConsolePrintHost
        d={d}
        onClose={() => void navigate({ search: p => ({ ...p, act: undefined, back: undefined }), replace: true })}
      />
    );
  }

  return (
    <ConsoleCardShell
      d={coldWait ? undefined : d}
      q={patternQ}
      act={act}
      back={back}
      requestedTab={requestedTab}
      documents={documents}
      certsCount={canCerts && certs.data ? certs.data.items.length : undefined}
      baseline={baseline}
    />
  );
}

function ConsolePrintHost({ d, onClose }: { d: Detail; onClose: () => void }) {
  const c = useCard(d);
  return (
    <Suspense fallback={<CardSkeleton />}>
      <CardPrint c={c} onClose={onClose} />
    </Suspense>
  );
}

function ConsoleCardShell({
  d,
  q,
  act,
  back,
  requestedTab,
  documents,
  certsCount,
  baseline,
}: {
  d: Detail | undefined;
  q: ReadState;
  act?: string;
  back?: string;
  requestedTab: CardTab;
  documents: boolean;
  certsCount?: number;
  baseline: () => React.ReactNode;
}) {
  const [actionsOpened, setActionsOpened] = useState(Boolean(act));
  if (act && !actionsOpened) setActionsOpened(true);
  const [done, setDone] = useState<Done | null>(null);
  const [current, setCurrent] = useState("s1");
  const [contract, setContract] = useState<ContractEdit>(null);
  const navigate = route.useNavigate();
  const pageActive = usePageActive();

  const tab = requestedTab === "docs" && !documents ? "card" : requestedTab;
  const open = (next: string, from?: string) =>
    next === "identifiers" && d
      ? void navigate({ to: "/people/$id/identifiers", params: { id: d.employee.id } })
      : void navigate({ search: p => ({ ...p, act: next, back: from, tab: next.startsWith("exit.") ? undefined : p.tab }) });
  const close = () => void navigate({ search: p => ({ ...p, act: undefined, back: undefined }), replace: true });
  const onTab = (x: CardTab) => void navigate({ search: p => ({ ...p, tab: x === "card" ? undefined : x }), replace: true });
  const go = (other: string) =>
    void navigate({ to: "/people/$id", params: { id: other }, search: { tab: tab === "card" ? undefined : tab } });
  const jumpTo = (secId: string) => {
    setCurrent(secId);
    focusSoon(secId);
  };

  if (!d) {
    return (
      <RecordPattern
        q={q}
        baseline={baseline}
        head={{ title: t("empCard.denied.crumb"), titleId: "person" }}
        sections={null}
      />
    );
  }

  return (
    <LoadedConsoleCard
      d={d}
      q={q}
      act={act}
      back={back}
      tab={tab}
      documents={documents}
      certsCount={certsCount}
      actionsOpened={actionsOpened}
      done={done}
      setDone={setDone}
      current={current}
      contract={contract}
      setContract={setContract}
      open={open}
      close={close}
      onTab={onTab}
      go={go}
      jumpTo={jumpTo}
      pageActive={pageActive}
      baseline={baseline}
    />
  );
}
