//! Find executable SQL mutations without charging words in SQL values or identifiers.
#[path = "rust_literals.rs"]
mod literals;
use std::{fs, path::Path};

pub(super) fn strip_rust(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut masked = bytes.to_vec();
    let mut at = 0;
    while at < bytes.len() {
        let end = if bytes[at..].starts_with(b"//") {
            Some(
                at + bytes[at..]
                    .iter()
                    .position(|b| *b == b'\n')
                    .unwrap_or(bytes.len() - at),
            )
        } else if bytes[at..].starts_with(b"/*") {
            Some(literals::block_comment_end(bytes, at).unwrap_or(bytes.len()))
        } else if bytes[at] == b'r' {
            let mut open = at + 1;
            while bytes.get(open) == Some(&b'#') {
                open += 1;
            }
            (bytes.get(open) == Some(&b'"')).then(|| {
                let delimiter = format!("\"{}", &source[at + 1..open]);
                source[open + 1..]
                    .find(&delimiter)
                    .map_or(bytes.len(), |end| open + 1 + end + delimiter.len())
            })
        } else if bytes[at] == b'"'
            || (bytes[at] == b'\''
                && (bytes.get(at + 1) == Some(&b'\\')
                    || source[at + 1..].chars().nth(1) == Some('\'')))
        {
            let mut end = at + 1;
            while end < bytes.len() {
                if bytes[end] == b'\\' {
                    end += 2;
                } else if bytes[end] == bytes[at] {
                    end += 1;
                    break;
                } else {
                    end += 1;
                }
            }
            Some(end.min(bytes.len()))
        } else {
            None
        };
        if let Some(end) = end {
            for byte in &mut masked[at..end] {
                if *byte != b'\n' {
                    *byte = b' ';
                }
            }
            at = end;
        } else {
            at += 1;
        }
    }
    String::from_utf8_lossy(&masked).into_owned()
}

pub(super) fn contains_state_mutating_sql(body: &str) -> bool {
    let executable = super::strip_comments_and_strings(body).to_ascii_lowercase();
    let uses_sqlx_query = executable.contains("sqlx::query")
        || executable.contains("query!")
        || executable.contains("query_as!")
        || executable.contains("query_scalar!");
    uses_sqlx_query && literals::contents(body).iter().any(|sql| mutates(sql))
}

pub(super) fn contains_audit_insert(file: &Path, source: &str) -> bool {
    let stripped = super::strip_comments_and_strings(source);
    let executable: String = stripped.chars().filter(|c| !c.is_whitespace()).collect();
    // shortcut: query_file macros fail closed; resolve crate-relative paths before allowing them.
    if ["query_file!", "query_file_as!", "query_file_scalar!"]
        .iter()
        .any(|name| executable.contains(name))
    {
        return true;
    }
    let code = stripped.as_bytes();
    for (at, token) in code.windows(b"include_str".len()).enumerate() {
        if token != b"include_str" {
            continue;
        }
        let Some(arguments) = source[at + token.len()..]
            .trim_start()
            .strip_prefix('!')
            .map(str::trim_start)
        else {
            continue;
        };
        let closing = match arguments.as_bytes().first() {
            Some(b'(') => ')',
            Some(b'[') => ']',
            Some(b'{') => '}',
            _ => return true,
        };
        let Some(end) = arguments.find(closing) else {
            return true;
        };
        let arguments = &arguments[1..end];
        let paths = literals::contents(arguments);
        if paths.len() != 1
            || !super::strip_comments_and_strings(arguments)
                .trim_matches(|c: char| c.is_whitespace() || c == ',')
                .is_empty()
        {
            return true;
        }
        let path = file.parent().unwrap_or(Path::new(".")).join(&paths[0]);
        match fs::read_to_string(path) {
            Ok(sql) if !audit_insert(&sql) => {}
            _ => return true,
        }
    }
    literals::contents(source)
        .iter()
        .any(|sql| audit_insert(sql))
}

fn audit_insert(sql: &str) -> bool {
    let searchable = executable_sql(sql, false)
        .unwrap_or_else(|| sql.to_owned())
        .to_ascii_lowercase()
        .replace('.', " . ");
    let words: Vec<_> = searchable
        .split(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '_' | '.' | '&'))
        .filter(|word| !word.is_empty())
        .collect();
    let audit_or_unparsed = |i: usize| {
        // shortcut: Unicode relation names fail closed; decode UESCAPE before allowing them.
        words
            .get(i)
            .is_some_and(|word| matches!(*word, "audit_events" | "u&"))
    };
    words.windows(3).enumerate().any(|(i, words_at)| {
        words_at[..2] == ["insert", "into"]
            && (audit_or_unparsed(i + 2)
                || (words.get(i + 3) == Some(&".") && audit_or_unparsed(i + 4)))
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
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || !c.is_ascii())
    {
        return None;
    }
    if tag
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || !c.is_ascii())
    {
        sql.get(..=end)
    } else {
        None
    }
}
