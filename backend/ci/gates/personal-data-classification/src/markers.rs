//! Column classification markers share the schema scan's finite-loop expansion.
use super::{MARKER_PREFIX, Marker, Tok, finite_foreach, lex, statements};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Parse classifications from ordinary comments and fully bounded table loops.
#[must_use]
pub fn parse_markers(files: &[PathBuf]) -> Vec<Marker> {
    let mut markers = Vec::new();
    for file in files {
        let Ok(content) = fs::read_to_string(file) else {
            continue;
        };
        let tokens = finite_foreach::expand(lex(&content));
        for statement in statements(&tokens) {
            let head: Vec<&str> = statement.iter().take(3).filter_map(Tok::word).collect();
            if head.first().copied() != Some("comment")
                || head.get(1).copied() != Some("on")
                || head.get(2).copied() != Some("column")
            {
                continue;
            }
            let Some(marker) = read_marker(statement, file) else {
                continue;
            };
            markers.push(marker);
        }
    }
    markers
}

fn read_marker(statement: &[Tok], file: &Path) -> Option<Marker> {
    // COMMENT ON COLUMN [schema.]table.column IS 'body'
    let mut parts: Vec<String> = Vec::new();
    let mut cursor = 3usize;
    loop {
        let word = statement.get(cursor)?.word()?;
        if word == "is" {
            break;
        }
        parts.push(word.to_owned());
        cursor += 1;
        if statement.get(cursor).is_some_and(|t| t.is_punct('.')) {
            cursor += 1;
        } else {
            break;
        }
    }
    while statement.get(cursor).and_then(Tok::word) != Some("is") {
        cursor += 1;
        if cursor >= statement.len() {
            return None;
        }
    }
    let body = match statement.get(cursor + 1)? {
        Tok::Str(s) => s.clone(),
        _ => return None,
    };
    let column = parts.pop()?;
    let table = parts.pop()?;

    let rest = body.strip_prefix(MARKER_PREFIX)?;
    let (token_text, note) = match rest.find(char::is_whitespace) {
        Some(at) => (&rest[..at], rest[at..].trim().to_owned()),
        None => (rest, String::new()),
    };
    let tokens = token_text
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();

    Some(Marker {
        table,
        column,
        tokens,
        note,
        file: file.to_path_buf(),
    })
}
