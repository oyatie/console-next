import { useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { FileUp } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import s from "./file-drop.module.css";

/** An accepted type: its MIME type and the extension shown to the user. */
export type Accept = { mime: string; ext: string };

/**
 * Drop a file or pick one (design §7.4). Type and size are checked here for a quick answer and again by
 * the server. On the Windows desktop shell, drop works only because the shell hands HTML5 drag and drop
 * to the page (apps/desktop); the picker always works. `multiple` takes several files at once.
 */
export function FileDrop({ label, hint, accept, maxBytes, multiple = false, onFiles, busy, error, children }: {
  label: string;
  hint?: ReactNode;
  accept: readonly Accept[];
  maxBytes: number;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  /** Upload or reading progress, shown in place of the drop hint. */
  busy?: ReactNode;
  error?: ReactNode;
  /** Shown under the zone, e.g. the chosen file and a preview. */
  children?: ReactNode;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const types = accept.map((a) => a.ext).join(", ");
  const take = (list: FileList | null) => {
    const files = [...(list ?? [])].slice(0, multiple ? undefined : 1);
    if (files.length === 0) return;
    const wrong = files.find((f) => !accept.some((a) => a.mime === f.type));
    const big = files.find((f) => f.size > maxBytes);
    if (wrong) return setRefused(t("uiFileDrop.wrongType", { name: wrong.name, types }));
    if (big) return setRefused(t("uiFileDrop.tooLarge", { name: big.name, mb: fmtNumber(Math.floor(maxBytes / 1048576)) }));
    setRefused(null);
    onFiles(files);
  };
  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files);
  };
  const shown = error ?? refused;
  return (
    <div className={s.wrap}>
      <div
        className={s.zone}
        data-over={over || undefined}
        aria-busy={busy != null || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <FileUp size={24} aria-hidden className={s.icon} />
        <span className={s.label} id={`${id}-l`}>{label}</span>
        <span className={s.hint}>{busy ?? hint ?? t("uiFileDrop.hint", { types, mb: fmtNumber(Math.floor(maxBytes / 1048576)) })}</span>
        <button type="button" className="btn btn--primary" disabled={busy != null} onClick={() => input.current?.click()} aria-describedby={`${id}-l`}>
          {t(multiple ? "uiFileDrop.pickMany" : "uiFileDrop.pick")}
        </button>
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          accept={accept.map((a) => a.mime).join(",")}
          multiple={multiple}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {shown != null && <p className={s.error} role="alert">{shown}</p>}
      {children}
    </div>
  );
}
