import type { koOrgTree } from "../ko/org-tree";

export const enOrgTree: Record<keyof typeof koOrgTree, string> = {
  "orgTree.act.register": "Register an employee in {name}",
  "orgTree.history.title": "History ({count, number})",
  "orgTree.history.created": "Created {date} · {name}",
  "orgTree.history.renamed": "Renamed {date} · {from} → {to}",
  "orgTree.history.moved": "{date} moved · {from} → {to}",
  "orgTree.history.dissolved": "Dissolved {date}",
  "orgTree.history.meta": "{actor} · {at}",
  "orgTree.history.code": "{date} code changed · {from} → {to}",
  "orgTree.history.head": "{date} head set · {from} → {to}",
  "orgTree.history.merged": "{date} merged · into {into}, dissolved (kept in the history)",
  "orgTree.history.none": "none",
  "orgTree.history.vacant": "vacant",
};
