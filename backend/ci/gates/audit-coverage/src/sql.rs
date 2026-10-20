//! Find executable SQL mutations without charging words in SQL values or identifiers.
#[path = "rust_literals.rs"]
mod literals;

pub(super) fn contains_state_mutating_sql(body: &str) -> bool {
    let executable = super::strip_comments_and_strings(body).to_ascii_lowercase();
    let uses_sqlx_query = executable.contains("sqlx::query")
        || executable.contains("query!")
        || executable.contains("query_as!")
        || executable.contains("query_scalar!");
    uses_sqlx_query && literals::contents(body).iter().any(|sql| mutates(sql))
}

pub(super) fn contains_audit_insert(source: &str) -> bool {
    literals::contents(source).iter().any(|sql| {
        let searchable = executable_sql(sql, false)
            .unwrap_or_else(|| sql.to_owned())
            .to_ascii_lowercase()
            .replace('.', " . ");
        let words: Vec<_> = searchable
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '.')
            .filter(|word| !word.is_empty())
            .collect();
        words.windows(3).enumerate().any(|(i, words_at)| {
            words_at[..2] == ["insert", "into"]
                && (words_at[2] == "audit_events"
                    || (words.get(i + 3) == Some(&".")
                        && words.get(i + 4) == Some(&"audit_events")))
        })
    })
}

fn mutates(sql: &str) -> bool {
    // Unknown quote/comment extents fail closed to the original keyword scan.
    let searchable = executable_sql(sql, true)
        .unwrap_or_else(|| sql.to_owned())
        .to_ascii_lowercase();
    let words: Vec<_> = searchable
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|word| !word.is_empty())
        .collect();
    words.iter().enumerate().any(|(i, word)| {
        matches!(*word, "insert" | "delete" | "merge" | "truncate" | "do")
            || (*word == "update" && words.get(i.wrapping_sub(1)) != Some(&"for"))
    })
}

fn executable_sql(sql: &str, mask_identifiers: bool) -> Option<String> {
    let bytes = sql.as_bytes();
    let mut masked = bytes.to_vec();
    let mut at = 0;
    while at < bytes.len() {
        let end = if matches!(bytes[at], b'\'' | b'"') {
            let escaped = bytes[at] == b'\''
                && at > 0
                && matches!(bytes[at - 1], b'e' | b'E')
                && super::is_word_boundary(bytes.get(at.wrapping_sub(2)).copied());
            Some(quoted_end(bytes, at, escaped)?)
        } else if bytes[at..].starts_with(b"--") {
            Some(
                at + bytes[at..]
                    .iter()
                    .position(|b| *b == b'\n')
                    .unwrap_or(bytes.len() - at),
            )
        } else if bytes[at..].starts_with(b"/*") {
            Some(literals::block_comment_end(bytes, at)?)
        } else if bytes[at] == b'$'
            && super::is_word_boundary(bytes.get(at.wrapping_sub(1)).copied())
        {
            if let Some(delimiter) = dollar_delimiter(&sql[at..]) {
                let start = at + delimiter.len();
                Some(start + sql[start..].find(delimiter)? + delimiter.len())
            } else {
                None
            }
        } else {
            None
        };
        if let Some(end) = end {
            if mask_identifiers || bytes[at] != b'"' {
                masked[at..end].fill(b' ');
            }
            at = end;
        } else {
            at += 1;
        }
    }
    String::from_utf8(masked).ok()
}

fn quoted_end(bytes: &[u8], start: usize, escaped: bool) -> Option<usize> {
    let delimiter = bytes[start];
    let mut at = start + 1;
    while at < bytes.len() {
        if escaped && bytes[at] == b'\\' {
            at += 2;
        } else if bytes[at] == delimiter {
            if bytes.get(at + 1) == Some(&delimiter) {
                at += 2;
            } else {
                return Some(at + 1);
            }
        } else {
            at += 1;
        }
    }
    None
}

fn dollar_delimiter(sql: &str) -> Option<&str> {
    let end = 1 + sql.get(1..)?.find('$')?;
    let tag = sql.get(1..end)?;
    if !tag.is_empty()
        && !tag
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
    {
        return None;
    }
    if tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        sql.get(..=end)
    } else {
        None
    }
}
