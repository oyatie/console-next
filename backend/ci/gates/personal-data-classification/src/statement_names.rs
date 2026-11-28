// SPDX-License-Identifier: LicenseRef-Proprietary
use super::Tok;

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
