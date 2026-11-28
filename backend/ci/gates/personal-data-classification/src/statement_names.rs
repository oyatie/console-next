// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{COLUMN_NEUTRAL_ALTER_ACTIONS, CONSTRAINT_HEADS, Tok};

/// Read a possibly schema-qualified name and return `(name, next_index)`.
pub(super) fn read_qualified_name(statement: &[Tok], index: usize) -> Option<(String, usize)> {
    let mut name = statement.get(index)?.word()?.to_owned();
    let mut cursor = index + 1;
    while statement.get(cursor).is_some_and(|t| t.is_punct('.')) {
        if let Some(part) = statement.get(cursor + 1).and_then(Tok::word) {
            name = part.to_owned();
            cursor += 2;
        } else {
            break;
        }
    }
    Some((name, cursor))
}

/// SET CONSTRAINTS changes when existing checks run within this transaction.
pub(super) fn sets_constraint_timing(statement: &[Tok]) -> bool {
    let Some((mode, names)) = statement.get(2..).and_then(<[Tok]>::split_last) else {
        return false;
    };
    if !matches!(mode.word(), Some("immediate" | "deferred")) {
        return false;
    }
    if matches!(names, [name] if name.word() == Some("all")) {
        return true;
    }
    names
        .split(|t| t.is_punct(','))
        .all(|name| read_qualified_name(name, 0).is_some_and(|(_, end)| end == name.len()))
}

pub(super) fn renames_constraint(action: &[Tok]) -> bool {
    matches!(action, [rename, constraint, old, to, new]
        if rename.word() == Some("rename") && constraint.word() == Some("constraint")
            && old.word().is_some() && to.word() == Some("to") && new.word().is_some())
}

pub(super) fn alter_action_is_column_neutral(action: &[Tok]) -> bool {
    let mut words = action.iter().filter_map(Tok::word);
    let Some(head) = words.next() else {
        return false;
    };
    if COLUMN_NEUTRAL_ALTER_ACTIONS.contains(&head) || renames_constraint(action) {
        return true;
    }
    // `ADD`/`DROP CONSTRAINT` is neutral, `ADD`/`DROP COLUMN` is not, and a
    // bare `ADD colname TYPE` is the implicit column form: the same distinction
    // `apply_alter_table` draws on parsed SQL, drawn here on opaque text.
    matches!(head, "add" | "drop")
        && words
            .next()
            .is_some_and(|next| CONSTRAINT_HEADS.contains(&next))
}
