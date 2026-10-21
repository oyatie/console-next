import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { descendants, type ChartNode } from "../domain/model";

/**
 * Delete in setup (Del, the ⋯ menu, the selection bar): one dialog for one or many department, never a delete at once.
 * Their sub-department go with them. A department with people is refused before sending (the server refuses it too:
 * org_unit_has_members), with the reason in place. routing the members elsewhere in the same step is the
 * S6 delete sheet (another lane); until it lands, people are moved first.
 * After go-live (org-05) each department ends by its own dated dissolution (its members, head and grants decided in its sheet), so
 * the dialog lists every chosen one with its own dissolve rather than acting on the first alone.
 */
export function DeleteDialog({ nodes, operating = false, onDelete, onOne, onClose }: {
  nodes: ChartNode[];
  operating?: boolean;
  onDelete: () => void;
  onOne?: (n: ChartNode) => void;
  onClose: () => void;
}) {
  const sub = nodes.reduce((n, d) => n + descendants(d).length, 0);
  const people = nodes.reduce((n, d) => n + d.headcount, 0);
  const name = nodes.length === 1 ? nodes[0]!.name : t("structure.move.many", { count: nodes.length });
  if (operating && onOne) {
    return (
      <Dialog open title={t("structure.delete.titleMany", { count: nodes.length })} onClose={onClose}>
        <p>{t("structure.delete.oneByOne")}</p>
        <ul className="stack" aria-label={t("structure.delete.chosen")}>
          {nodes.map((n) => (
            <li key={n.id} className="row">
              <span className="grow">{t("structure.delete.line", { name: n.name, count: n.headcount })}</span>
              <Button variant="danger" size="sm" onClick={() => onOne(n)}>{t("structure.delete.dissolveOne", { name: n.name })}</Button>
            </li>
          ))}
        </ul>
        <div className="form__actions">
          <Button variant="ghost" onClick={onClose}>{t("structure.cancel")}</Button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open title={t("structure.delete.title", { name })} onClose={onClose}>
      <p>{t("structure.delete.consequence", { name, sub })}</p>
      <div className="form__actions">
        <Button variant="ghost" onClick={onClose}>{t("structure.cancel")}</Button>
        {people > 0 ? (
          <DisabledReason control={(p) => <Button variant="danger" {...p}>{t("structure.delete.submit")}</Button>} reason={t("structure.delete.hasMembers", { count: people })} />
        ) : (
          <Button variant="danger" onClick={onDelete}>{t("structure.delete.submit")}</Button>
        )}
      </div>
    </Dialog>
  );
}
