// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, type ComponentProps } from "react";
import { chunk } from "../../../lib/chunk-guard";
import { FixEmpno } from "./fix-empno";

const CardActions = lazy(() => chunk(import("./person-act")).then(m => ({ default: m.CardActions })));

export function CardActionSheets(props: ComponentProps<typeof CardActions>) {
  const { c, act, onOpen, onClose } = props;
  return <>
    {act === "empno" && <FixEmpno c={c} onClose={onClose} onCorrect={() => onOpen("fix:employee_number")} />}
    <Suspense fallback={null}><CardActions {...props} /></Suspense>
  </>;
}
