import { useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Avatar } from "../../../ui/avatar/avatar";
import { Button } from "../../../ui/button/button";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { FieldRow } from "../../../ui/record/field-row";
import { PathNote, RowActions } from "../../../ui/record-actions/record-actions";
import { Sheet } from "../../../ui/sheet/sheet";
import { uploadPhoto } from "../api/record";
import type { Card } from "./use-card";
import type { Quick } from "./use-quick";
import { Who } from "./card-who";
import s from "./card.module.css";
import { Muted } from "../../../ui/muted/muted";

const route = getRouteApi("/app/people/$id");

/** The types and size the server takes (hr domain PHOTO_CONTENT_TYPES, PHOTO_MAX_BYTES). */
const ACCEPT = [{ mime: "image/jpeg", ext: "JPG" }, { mime: "image/png", ext: "PNG" }, { mime: "image/webp", ext: "WebP" }] as const;
const MAX = 5 * 1024 * 1024;

/** photo on the card: the photo itself, photo add or edit (replace), and the overflow menu delete (setup) or void (after go-live). */
export function PhotoRow({ c, quick }: { c: Card; quick: Quick }) {
  // The palette's photo add opens the card with ?act=photo.add (Back closes it).
  const { act } = route.useSearch();
  const navigate = route.useNavigate();
  const [state, setOpen] = useState(false);
  const open = state || act === "photo.add";
  const close = () => (setOpen(false), act === "photo.add" && void navigate({ search: (x) => ({ ...x, act: undefined }), replace: true }));
  const photo = c.personal.data?.photo;
  const label = t("empCard.f.photo");
  return (
    <FieldRow
      id="f-photo"
      label={label}
      mark={
        c.manage && (
          <RowActions
            field={label}
            edit={photo ? "edit" : "add"}
            onEdit={() => setOpen(true)}
            end={photo ? { verb: c.setup ? "delete" : "void", onPress: () => quick.save(label, { photo: null }, { photo: photo.upload_id }) } : undefined}
          />
        )
      }
    >
      {photo ? <span className={s.photoCell}><Avatar size="md" name={c.e.name} src={photo.url ?? undefined} alt={t("empCard.photo", { name: c.e.name })} /> {t("empCard.photo.on")}</span> : <Muted>{t("empCard.none")}</Muted>}
      {open && <PhotoSheet c={c} replace={Boolean(photo)} onClose={close} />}
    </FieldRow>
  );
}

function PhotoSheet({ c, replace, onClose }: { c: Card; replace: boolean; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const run = useCommand({
    run: () => uploadPhoto(c.e.id, c.e.updated_at, file!, (status) => t("empPhoto.putFailed", { status })),
    invalidates: ["/api/v1/employees"],
    settle: true,
    onSuccess: onClose,
    announce: () => t("empPhoto.done"),
  });
  const title = t(replace ? "empPhoto.edit" : "empPhoto.add");
  const pick = (f: File) => {
    setFile(f);
    setPreview((old) => (old && URL.revokeObjectURL(old), URL.createObjectURL(f)));
  };
  return (
    <Sheet
      open
      kicker={<Who c={c} />}
      title={title}
      onClose={() => (preview && URL.revokeObjectURL(preview), onClose())}
      pending={run.isPending}
      notice={run.isError && <CommandError error={run.error} own={(code) => (code === "photo_storage_unavailable" ? t("empPhoto.unavailable") : undefined)} />}
      consequence={<PathNote path={c.setup ? "setup" : "correction"} />}
      actions={
        <>

          <Button variant="primary" aria-disabled={!file || undefined} onClick={() => file && run.mutate(undefined)}>{title}</Button>
        </>
      }
    >
      <FileDrop label={t("empPhoto.drop")} accept={ACCEPT} maxBytes={MAX} onFiles={([f]) => f && pick(f)} busy={run.isPending ? t("empPhoto.sending") : undefined}>
        {preview && file && <span className={s.photoCell}><Avatar size="lg" name={c.e.name} src={preview} alt={t("empPhoto.preview", { name: file.name })} /> {file.name}</span>}
      </FileDrop>
    </Sheet>
  );
}
