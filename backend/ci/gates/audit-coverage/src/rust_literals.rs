//! Isolated, decoded Rust literals; SQL quoting must never cross their boundaries.
pub(super) fn contents(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut values = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at..].starts_with(b"//") {
            at += bytes[at..]
                .iter()
                .position(|b| *b == b'\n')
                .unwrap_or(bytes.len() - at);
        } else if bytes[at..].starts_with(b"/*") {
            at = block_comment_end(bytes, at).unwrap_or(bytes.len());
        } else if bytes[at] == b'r' {
            let mut open = at + 1;
            while bytes.get(open) == Some(&b'#') {
                open += 1;
            }
            if bytes.get(open) == Some(&b'"') {
                let delimiter = format!("\"{}", &source[at + 1..open]);
                let start = open + 1;
                if let Some(end) = source[start..].find(&delimiter) {
                    values.push(source[start..start + end].to_owned());
                    at = start + end + delimiter.len();
                } else {
                    values.push(source[start..].to_owned());
                    break;
                }
            } else {
                at += 1;
            }
        } else if bytes[at] == b'"' {
            if let Some((value, end)) = decoded(source, at + 1) {
                values.push(value);
                at = end;
            } else {
                values.push(source[at + 1..].to_owned());
                break;
            }
        } else if bytes[at] == b'\'' {
            at = char_end(source, at).unwrap_or(at + 1);
        } else {
            at += 1;
        }
    }
    values
}

fn decoded(source: &str, mut at: usize) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    let mut value = String::new();
    while at < bytes.len() {
        if bytes[at] == b'"' {
            return Some((value, at + 1));
        }
        if bytes[at] != b'\\' {
            let c = source.get(at..)?.chars().next()?;
            value.push(c);
            at += c.len_utf8();
            continue;
        }
        at += 1;
        let escaped = *bytes.get(at)?;
        match escaped {
            b'n' => value.push('\n'),
            b'r' => value.push('\r'),
            b't' => value.push('\t'),
            b'0' => value.push('\0'),
            b'\\' | b'"' | b'\'' => value.push(escaped as char),
            b'x' => {
                let hex = source.get(at + 1..at + 3)?;
                value.push(u8::from_str_radix(hex, 16).ok()? as char);
                at += 2;
            }
            b'u' if bytes.get(at + 1) == Some(&b'{') => {
                let start = at + 2;
                let end = start + source.get(start..)?.find('}')?;
                let hex = source.get(start..end)?.replace('_', "");
                value.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                at = end;
            }
            b'\n' | b'\r' => {
                while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
                    at += 1;
                }
                continue;
            }
            _ => return None,
        }
        at += 1;
    }
    None
}

fn char_end(source: &str, start: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut at = start + 1;
    if bytes.get(at) == Some(&b'\\') {
        at += 1;
        match bytes.get(at)? {
            b'x' => at += 3,
            b'u' if bytes.get(at + 1) == Some(&b'{') => {
                at += source.get(at..)?.find('}')? + 1;
            }
            _ => at += 1,
        }
    } else {
        at += source.get(at..)?.chars().next()?.len_utf8();
    }
    (bytes.get(at) == Some(&b'\'')).then_some(at + 1)
}

pub(super) fn block_comment_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut at = start + 2;
    let mut depth = 1;
    while at < bytes.len() {
        if bytes[at..].starts_with(b"/*") {
            depth += 1;
            at += 2;
        } else if bytes[at..].starts_with(b"*/") {
            depth -= 1;
            at += 2;
            if depth == 0 {
                return Some(at);
            }
        } else {
            at += 1;
        }
    }
    None
}
