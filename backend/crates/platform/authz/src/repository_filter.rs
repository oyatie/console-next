use console_kernel_core::{BranchScope, KernelError};

/// A validated SQL identifier for a branch column, e.g. `work_orders.branch_id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BranchColumn(&'static str);

impl BranchColumn {
    pub fn new(raw: &'static str) -> Result<Self, KernelError> {
        if is_safe_column(raw) {
            Ok(Self(raw))
        } else {
            Err(KernelError::validation(format!(
                "unsafe branch column identifier: {raw}"
            )))
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

/// A SQL predicate plus branch IDs to bind as `$1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlPredicate {
    sql: String,
    branch_ids: Vec<uuid::Uuid>,
}

impl SqlPredicate {
    #[must_use]
    pub fn sql(&self) -> &str {
        &self.sql
    }

    #[must_use]
    pub fn branch_ids(&self) -> &[uuid::Uuid] {
        &self.branch_ids
    }
}

/// Produce the default branch predicate for repository list/detail queries.
///
/// For explicit empty scope, this returns `FALSE`, not an empty `ANY` clause,
/// making the default deny behavior visible in generated SQL.
pub fn repository_filter(
    scope: &BranchScope,
    column: BranchColumn,
) -> Result<SqlPredicate, KernelError> {
    match scope {
        BranchScope::All => Ok(SqlPredicate {
            sql: "TRUE".to_owned(),
            branch_ids: Vec::new(),
        }),
        BranchScope::Branches(branches) if branches.is_empty() => Ok(SqlPredicate {
            sql: "FALSE".to_owned(),
            branch_ids: Vec::new(),
        }),
        BranchScope::Branches(branches) => Ok(SqlPredicate {
            sql: format!("{} = ANY($1)", column.as_str()),
            branch_ids: branches.iter().map(|branch| *branch.as_uuid()).collect(),
        }),
    }
}

pub(crate) fn is_safe_column(raw: &str) -> bool {
    let mut segments = raw.split('.');
    let first = segments.next();
    let second = segments.next();
    let too_many = segments.next().is_some();

    match (first, second, too_many) {
        (Some(column), None, false) => is_safe_ident(column),
        (Some(table), Some(column), false) => is_safe_ident(table) && is_safe_ident(column),
        _ => false,
    }
}

fn is_safe_ident(raw: &str) -> bool {
    let mut chars = raw.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    matches!(first, 'a'..='z' | '_') && chars.all(|ch| matches!(ch, 'a'..='z' | '0'..='9' | '_'))
}
