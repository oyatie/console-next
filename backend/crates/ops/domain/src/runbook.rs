// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorKind {
    HtmlId,
    Heading,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunbookAnchor {
    pub slug: String,
    pub kind: AnchorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

pub fn extract_runbook_anchors(markdown: &str) -> Vec<RunbookAnchor> {
    let mut anchors = Vec::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let mut fence: Option<(char, usize)> = None;

    for line in markdown.lines() {
        let stripped = line.trim_start();
        if let Some((marker_ch, marker_len)) = fence_marker(stripped) {
            match fence {
                None => {
                    let rest = &stripped[marker_len..];
                    if marker_ch == '~' || !rest.contains('`') {
                        fence = Some((marker_ch, marker_len));
                        continue;
                    }
                }
                Some((open_ch, open_len)) => {
                    let rest = &stripped[marker_len..];
                    if marker_ch == open_ch && marker_len >= open_len && rest.trim().is_empty() {
                        fence = None;
                        continue;
                    }
                }
            }
        }
        if fence.is_some() {
            continue;
        }

        for id in extract_html_anchor_ids(line) {
            anchors.push(RunbookAnchor {
                slug: id,
                kind: AnchorKind::HtmlId,
                title: None,
            });
        }

        if let Some(heading_raw) = parse_atx_heading(line) {
            let cleaned = clean_heading_text(heading_raw);
            let slug_base = github_slug(&cleaned);
            let count = seen.get(&slug_base).copied().unwrap_or(0);
            seen.insert(slug_base.clone(), count + 1);
            let slug = if count == 0 {
                slug_base
            } else {
                format!("{slug_base}-{count}")
            };
            anchors.push(RunbookAnchor {
                slug,
                kind: AnchorKind::Heading,
                title: Some(cleaned),
            });
        }
    }

    anchors
}

fn fence_marker(line: &str) -> Option<(char, usize)> {
    let first = line.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let count = line.bytes().take_while(|b| *b == first as u8).count();
    (count >= 3).then_some((first, count))
}

fn extract_html_anchor_ids(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(pos) = rest.find("<a") {
        let after = &rest[pos + 2..];
        let Some(first_ws) = after.chars().next() else {
            break;
        };
        if !first_ws.is_whitespace() {
            rest = after;
            continue;
        }
        let Some(close) = after.find('>') else {
            break;
        };
        let tag = &after[..close];
        for attr in ["id=", "name="] {
            if let Some(idx) = tag.find(attr) {
                let val_part = &tag[idx + attr.len()..];
                if let Some(quote) = val_part.chars().next().filter(|q| *q == '"' || *q == '\'')
                    && let Some(end_q) = val_part[1..].find(quote)
                {
                    let id = &val_part[1..1 + end_q];
                    if !id.is_empty() {
                        out.push(id.to_owned());
                    }
                }
            }
        }
        rest = &after[close + 1..];
    }
    out
}

fn parse_atx_heading(line: &str) -> Option<&str> {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let after = &line[hashes..];
    if !after.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    let trimmed = after.trim().trim_end_matches('#').trim_end();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn clean_heading_text(raw: &str) -> String {
    let without_links = strip_markdown_links(raw);
    let without_code = without_links.replace('`', "");
    strip_html_tags(&without_code)
}

fn strip_markdown_links(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open_b) = rest.find('[') {
        out.push_str(&rest[..open_b]);
        let after_b = &rest[open_b + 1..];
        if let Some(close_b) = after_b.find(']') {
            let label = &after_b[..close_b];
            let after_label = &after_b[close_b + 1..];
            if let Some(after_p) = after_label.strip_prefix('(')
                && let Some(close_p) = after_p.find(')')
            {
                out.push_str(label);
                rest = &after_p[close_p + 1..];
                continue;
            }
        }
        out.push('[');
        rest = after_b;
    }
    out.push_str(rest);
    out
}

fn strip_html_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn github_slug(heading: &str) -> String {
    let mut out = String::with_capacity(heading.len());
    for ch in heading.trim().to_lowercase().chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    out
}
