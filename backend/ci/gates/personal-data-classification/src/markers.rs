//! Column classification markers share the schema scan's finite-loop expansion.
use super::{MARKER_PREFIX, Marker, Tok, finite_foreach, lex, statements};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Parse classifications from ordinary comments and fully bounded table loops.
#[must_use]
pub fn parse_markers(files: &[PathBuf]) -> Vec<Marker> {
    let mut markers: Vec<Marker> = Vec::new();
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
            // A later migration may refresh prose while retaining the exact classification.
            if let Some(previous) = markers.iter_mut().find(|previous| {
                previous.table == marker.table
                    && previous.column == marker.column
                    && previous.tokens == marker.tokens
                    && previous.file != marker.file
            }) {
                *previous = marker;
            } else {
                markers.push(marker);
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    fn files(second: &str, same_file: bool) -> std::io::Result<Vec<PathBuf>> {
        let dir = std::env::temp_dir().join(format!(
            "pd-comment-update-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir)?;
        let first = "COMMENT ON COLUMN events.leave_type IS 'pd:personal,sensitive/health — MATERNITY reveals health';";
        let a = dir.join("0001.sql");
        if same_file {
            fs::write(&a, format!("{first}\n{second}"))?;
            return Ok(vec![a]);
        }
        let b = dir.join("0002.sql");
        fs::write(&a, first)?;
        fs::write(&b, second)?;
        Ok(vec![a, b])
    }
    #[test]
    fn a_later_migration_can_refresh_the_note_without_reclassifying() -> std::io::Result<()> {
        let files = files(
            "COMMENT ON COLUMN events.leave_type IS 'pd:personal,sensitive/health — MATERNITY and WORK_INJURY reveal health';",
            false,
        )?;
        let markers = parse_markers(&files);
        assert_eq!(markers.len(), 1);
        assert!(markers[0].note.contains("WORK_INJURY"));
        assert_eq!(markers[0].file, files[1]);
        Ok(())
    }
    #[test]
    fn a_changed_class_or_a_duplicate_in_one_migration_still_reaches_validation()
    -> std::io::Result<()> {
        assert_eq!(
            parse_markers(&files(
                "COMMENT ON COLUMN events.leave_type IS 'pd:none — downgraded';",
                false
            )?)
            .len(),
            2
        );
        assert_eq!(parse_markers(&files("COMMENT ON COLUMN events.leave_type IS 'pd:personal,sensitive/health — duplicate';",true)?).len(),2);
        Ok(())
    }
}
