//! Branch-scope SQL fragments shared by the HR reads.

use console_kernel_core::BranchScope;
use sqlx::{Postgres, QueryBuilder};

pub fn push_branch_scope_column(
    builder: &mut QueryBuilder<Postgres>,
    scope: &BranchScope,
    column: &'static str,
) {
    match scope {
        BranchScope::All => {
            builder.push(" TRUE ");
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" FALSE ");
        }
        BranchScope::Branches(branches) => {
            let ids = branches
                .iter()
                .map(|branch| *branch.as_uuid())
                .collect::<Vec<_>>();
            builder.push(column);
            builder.push(" = ANY(");
            builder.push_bind(ids);
            builder.push(") ");
        }
    };
}
