import { Download } from "lucide-react";
import type { EntityDocument } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { Button } from "../../../ui/button/button";
import { documentContent } from "../api";

/**
 * The kept original of an evidence document, saved as its own file name. It is fetched only on request: the
 * original carries personal data, so nothing caches it and the object URL is released at once.
 */
export function OpenOriginal({ doc }: { doc: EntityDocument }) {
  const open = useCommand({
    run: () => documentContent(doc.id),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: doc.file_name });
      a.click();
      URL.revokeObjectURL(url);
    },
    forget: true,
  });
  return (
    <>
      <Button variant="ghost" onClick={() => open.mutate(undefined)} disabled={open.isPending} aria-busy={open.isPending} aria-label={t("capture.docs.openLabel", { file: doc.file_name })}>
        <Download size={16} aria-hidden /> {t("capture.docs.open")}
      </Button>
      <EntityError error={open.error} />
    </>
  );
}
