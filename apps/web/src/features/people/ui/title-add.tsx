import { useState } from "react";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { TextInput } from "../../../ui/field/field";
import { addJobTitle, updateJobTitle, type JobTitleKind } from "../api";
import { Banner } from "../../../ui/banner/banner";
import s from "./lifecycle.module.css";

const LABEL_MAX = 100;

/**
 * The add chip at the end of a catalog's chips (spec E5-appoint, BE-EMP-UI §1): the entry is added to the company's list
 * and chosen at once. Drawn only when the server says this user keeps the list (`can_manage`); the same label again
 * answers the existing entry, so a second press adds nothing.
 */
export function TitleAdd({ kind, what, onAdded }: { kind: JobTitleKind; what: string; onAdded: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [inactive, setInactive] = useState<{ id: string; label: string } | null>(null);
  const chosen = (row: { id: string }) => (onAdded(row.id), setInactive(null), setText(""), setOpen(false));
  const activate = useCommand({
    run: () => updateJobTitle(inactive!.id, { active: true }),
    invalidates: ["/api/v1/job-titles"],
    settle: true,
    onSuccess: chosen,
  });
  const add = useCommand({
    run: () => addJobTitle({ kind, label: text.trim(), grade_rank: null }),
    invalidates: ["/api/v1/job-titles"],
    settle: true,
    onSuccess: (row) => row.active ? chosen(row) : setInactive(row),
  });
  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}><Plus size={14} aria-hidden />{t("lifecycle.appoint.add", { what })}</Button>;
  return (
    <div className={s.addRow}>
      <TextInput
        aria-label={t("lifecycle.appoint.addLabel", { what })}
        maxLength={LABEL_MAX}
        value={text}
        // The field it opened takes focus (the press asked for it), as a ref rather than autoFocus.
        ref={(el) => el?.focus()}
        onChange={(e) => (setInactive(null), setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (text.trim()) add.mutate(undefined);
        }}
      />
      <Button aria-disabled={!text.trim() || add.isPending || undefined} onClick={() => void (text.trim() && add.mutate(undefined))}>{t("lifecycle.appoint.addCommit")}</Button>
      <CommandError error={add.error} />
      {inactive && <Banner tone="warn" title={t("people.title.inactive", { label: inactive.label })} actions={<Button disabled={activate.isPending} onClick={() => activate.mutate(undefined)}>{t("people.title.reactivate")}</Button>}>{t("people.title.inactiveBody")}</Banner>}
      <CommandError error={activate.error} />
    </div>
  );
}
