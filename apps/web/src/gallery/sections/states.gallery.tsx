import { useState } from "react";
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Button } from "../../ui/button/button";
import { EmptyState } from "../../ui/empty-state";
import { QueryState } from "../../lib/react/query-state";
import { Dialog } from "../../ui/dialog";
import { failure } from "../fixtures";
import { Section } from "../Section";

export const order = 30;

const noop = () => undefined;

export default function States() {
  const [dialog, setDialog] = useState(false);
  const [retried, setRetried] = useState(false);
  return (
    <Section title={tg("section.states")}>
      <EmptyState
        title={tg("empty.title")}
        reason={tg("empty.reason")}
        actions={<Button variant="primary" onClick={() => setDialog(true)}>{tg("dialog.open")}</Button>}
      />
      <QueryState q={{ isPending: true, error: null, data: undefined, refetch: noop }}>{() => null}</QueryState>
      <QueryState q={{ isPending: false, error: retried ? null : failure(), data: retried ? tg("state.loaded") : undefined, refetch: () => setRetried(true) }}>
        {(d) => <div className="state">{d}</div>}
      </QueryState>
      <QueryState q={{ isPending: false, error: new ApiError(403, "forbidden", ""), data: undefined, refetch: noop }}>{() => null}</QueryState>
      {/* The overlay portals to <body>, so where it is declared does not change the page. */}
      <Dialog open={dialog} title={tg("dialog.title")} onClose={() => setDialog(false)}>
        <span className="muted">{tg("dialog.body")}</span>
        <div className="form__actions">
          <Button onClick={() => setDialog(false)}>{t("common.back")}</Button>
        </div>
      </Dialog>
    </Section>
  );
}
