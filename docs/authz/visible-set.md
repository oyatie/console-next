<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Cedar scope-node visible sets

Slice 2 adds `cedar_pbac::visible::load_facts` and `DecisionFacts::{authorize, visible}`.
No serving endpoint changes its access in this slice. The next slice adopts the mechanism on attendance and people reads.

Load facts once in the use-case transaction with tenant RLS armed. The loader refuses bypass-RLS connections, mismatched tenants and inactive/missing accounts. It reuses `load_access_subject`, `scope_path` and `dept_path`: effective role versions, grant dates, tenant phase and canonical ancestor paths have one source. Callers supply actor identity and a typed node reference, never scope booleans or a grant predicate.

`authorize(action, node)` evaluates the existing strict-validated Cedar role templates, action catalog and entity hierarchy. `visible(action, NodeKind, column, first_bind)` asks the same Cedar slice about each loaded node of that type, then passes the permitted node IDs to D1. D1 emits a safe UUID-to-text comparison against a bound array. This enumerates scope nodes, never person/record rows; it does not reproduce Cedar's `in` relation in Rust or SQL. Unknown nodes deny even for tenant grants. Dissolved/incomplete paths deny; policy/evaluation failures refuse the whole set.

For a scope-node UUID column `p.scope_node_id`, request a filter starting after the query's existing binds. Append `AND <filter.where_sql>` to the tenant-scoped query and bind `filter.binds` in order. Apply that same filter to both the count and the list. A link must carry the permitted node itself. Neither the filter nor a point permit replaces RLS.

This first service supports the existing node-action schema (`NodeKind`), including its platform isolation forbid and ops policy. It does not accept arbitrary record-attribute/step-up/SoD policies: those require shared record facts and their action schemas before migration. Do not use a node permit as a substitute for a record-dependent action. Refresh the snapshot for every decision transaction; it is not a cross-request cache. Current loading reuses the department path loader per node; batch its database reads if measured tree size requires it.

`visible_set` is the DB proof: eight reproducibly generated tenant trees, nested departments, all four grant scope kinds, no grants and ops; for read/manage and every node, Cedar authorization equals membership in the actual SQL result, and count equals list length. It also checks tenant RLS, missing/inactive actors, revoked grants, foreign/unknown nodes, unknown actions, unsafe column names and invalid bind offsets. The existing ontology residual DB binary proves unchanged instance-policy permit/forbid semantics.
