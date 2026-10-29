// SPDX-License-Identifier: LicenseRef-Proprietary
pub(super) fn sanitize_sql(content: &str, mask_bodies: bool) -> String {
    let bytes = content.as_bytes();
    let mut output = String::with_capacity(content.len());
    let mut index = 0usize;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut in_single_quote = false;
    let mut in_double_quote = false;

    while index < bytes.len() {
        let b = bytes[index];
        let next = bytes.get(index + 1).copied();

        if in_line_comment {
            if b == b'\n' {
                in_line_comment = false;
                output.push('\n');
            } else {
                output.push(' ');
            }
            index += 1;
            continue;
        }
        if in_block_comment {
            if b == b'*' && next == Some(b'/') {
                in_block_comment = false;
                output.push_str("  ");
                index += 2;
            } else {
                output.push(if b == b'\n' { '\n' } else { ' ' });
                index += 1;
            }
            continue;
        }
        if in_single_quote {
            if b == b'\'' && next == Some(b'\'') {
                output.push_str("  ");
                index += 2;
            } else if b == b'\'' {
                in_single_quote = false;
                output.push(' ');
                index += 1;
            } else {
                output.push(if b == b'\n' { '\n' } else { ' ' });
                index += 1;
            }
            continue;
        }
        if in_double_quote {
            if b == b'"' {
                in_double_quote = false;
                output.push(' ');
            } else {
                output.push((b as char).to_ascii_lowercase());
            }
            index += 1;
            continue;
        }

        if mask_bodies && b == b'$' {
            let tail = &content[index + 1..];
            if let Some(end) = tail.find('$')
                && tail[..end]
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
            {
                let delimiter = &content[index..index + end + 2];
                let body_start = index + delimiter.len();
                if let Some(close) = content[body_start..].find(delimiter) {
                    output.push_str(" __sql_literal__ ");
                    index = body_start + close + delimiter.len();
                    continue;
                }
                output.push_str(" __unparsed_sql__");
                break;
            }
        }
        if b == b'-' && next == Some(b'-') {
            in_line_comment = true;
            output.push_str("  ");
            index += 2;
        } else if b == b'/' && next == Some(b'*') {
            in_block_comment = true;
            output.push_str("  ");
            index += 2;
        } else if b == b'\'' {
            in_single_quote = true;
            output.push_str(" __sql_literal__ ");
            index += 1;
        } else if b == b'"' {
            in_double_quote = true;
            if mask_bodies {
                output.push_str("__quoted_identifier__");
            } else {
                output.push(' ');
            }
            index += 1;
        } else {
            output.push((b as char).to_ascii_lowercase());
            index += 1;
        }
    }

    if in_single_quote || in_double_quote || in_block_comment {
        output.push_str(" __unparsed_sql__");
    }
    output
}
