// SPDX-License-Identifier: LicenseRef-Proprietary
use super::FilingQuery;
use sqlx::{Postgres, QueryBuilder};

pub(super) fn push_page_order(q: &mut QueryBuilder<Postgres>, query: &FilingQuery) -> &'static str {
    if let Some(limit) = query.inbox_scan_limit {
        if let Some((created_at, id)) = &query.inbox_after {
            q.push(" WHERE (created_at, inbox_id) > (")
                .push_bind(*created_at)
                .push(", ")
                .push_bind(id.clone())
                .push(")");
        }
        let order = " ORDER BY created_at, inbox_id";
        q.push(order)
            .push(" LIMIT ")
            .push_bind(i64::try_from(limit).unwrap_or(i64::MAX));
        order
    } else {
        let order = " ORDER BY effective_date,id,kind,insurer";
        q.push(order);
        order
    }
}
