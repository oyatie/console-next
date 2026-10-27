// SPDX-License-Identifier: LicenseRef-Proprietary
//! The SQL half of the inbox's deadline/creation/id keyset (undated last).
use sqlx::{Postgres, QueryBuilder};
use time::OffsetDateTime;

/// Expressions are static, source-owned SQL; visibility and snapshot predicates are already applied.
pub fn push_page(
    q: &mut QueryBuilder<Postgres>,
    due: &'static str,
    created: &'static str,
    id: &'static str,
    after: Option<(Option<OffsetDateTime>, OffsetDateTime, String)>,
    limit: i64,
) {
    if let Some((after_due, after_created, after_id)) = after {
        q.push(" AND (");
        if let Some(at) = after_due {
            q.push(due)
                .push(" IS NULL OR ")
                .push(due)
                .push(" > ")
                .push_bind(at)
                .push(" OR (")
                .push(due)
                .push(" = ")
                .push_bind(at)
                .push(" AND ");
        } else {
            q.push(due).push(" IS NULL AND (");
        }
        q.push("(")
            .push(created)
            .push(", ")
            .push(id)
            .push(") > (")
            .push_bind(after_created)
            .push(", ")
            .push_bind(after_id)
            .push(")))");
    }
    q.push(" ORDER BY ")
        .push(due)
        .push(" ASC NULLS LAST, ")
        .push(created)
        .push(" ASC, ")
        .push(id)
        .push(" ASC LIMIT ")
        .push_bind(limit.saturating_add(1));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undated_cursor_never_readmits_dated_rows_and_dated_cursor_keeps_undated_tail() {
        for (due, expected) in [
            (
                None,
                "SELECT * FROM work WHERE true AND (due IS NULL AND ((created_at, id) > ($1, $2))) ORDER BY due ASC NULLS LAST, created_at ASC, id ASC LIMIT $3",
            ),
            (
                Some(OffsetDateTime::UNIX_EPOCH),
                "SELECT * FROM work WHERE true AND (due IS NULL OR due > $1 OR (due = $2 AND (created_at, id) > ($3, $4))) ORDER BY due ASC NULLS LAST, created_at ASC, id ASC LIMIT $5",
            ),
        ] {
            let mut q = QueryBuilder::new("SELECT * FROM work WHERE true");
            push_page(
                &mut q,
                "due",
                "created_at",
                "id",
                Some((due, OffsetDateTime::UNIX_EPOCH, "work:1".into())),
                50,
            );
            assert_eq!(q.sql(), expected);
        }
    }
}
