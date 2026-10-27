// SPDX-License-Identifier: LicenseRef-Proprietary
import { Ellipsis } from "lucide-react";
import { Button } from "react-aria-components";
import { buttonClass } from "../button/button-class";
import { ActionMenu, type MenuAction } from "../menu/action-menu";
import s from "./page-head.module.css";

/** Import with action-bearing heads so read-only page titles do not load the menu implementation. */
export function PageHeadActions({ label, items }: { label: string; items: readonly MenuAction[] }) {
  if (!items.length) return null;
  return <>
    <div className={s.secondary}>{items.map(action => <Button key={action.id} className={buttonClass(action.danger ? "ghost-danger" : "ghost")} onPress={action.onAction}>{action.label}</Button>)}</div>
    <div className={s.overflow}><ActionMenu label={label} trigger={<Ellipsis size={16} aria-hidden />} actions={items} /></div>
  </>;
}
