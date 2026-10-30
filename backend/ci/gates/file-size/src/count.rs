//! Code-line counting: the lines that carry code, minus the lines of items
//! compiled only under `cfg(test)`, except in integration-test source files.
//!
//! A small textual lexer drops comments (doc comments included) and blank
//! lines; every line of a multi-line literal is code. A `#[cfg(…)]` attribute
//! is handed to writer-ownership's `gated_to_test_builds`, so this gate and
//! that one cannot disagree about what ships; the gated item runs from the
//! attribute to its `;`, `,` or brace-balanced block.
//!
//! No `proc-macro2` `span-locations`: enabling it unifies the feature across
//! workspace builds and flips their fingerprints.

use std::collections::BTreeSet;

use console_gate_writer_ownership::gated_to_test_builds;
use syn::parse::Parser;

/// Code lines of one Rust source file.
///
/// Fails closed: a file that does not lex (unterminated literal or comment,
/// unbalanced delimiters) counts every non-blank line, and a file that lexes
/// but does not parse keeps its test items in the count.
#[must_use]
pub fn code_lines(path: &str, text: &str) -> usize {
    let Some(toks) = lex(text) else {
        return text.lines().filter(|line| !line.trim().is_empty()).count();
    };
    let mut lines: BTreeSet<usize> = toks.iter().flat_map(|t| t.line..=t.end_line).collect();
    if !path.split('/').any(|part| part == "tests") && syn::parse_file(text).is_ok() {
        let mut k = 0;
        while k < toks.len() {
            if let Some(end) = test_item_end(text, &toks, k) {
                for line in toks[k].line..=toks[end].end_line {
                    lines.remove(&line);
                }
                k = end;
            }
            k += 1;
        }
    }
    lines.len()
}

/// One code token: a punctuation char, or `'\0'` for an identifier, number,
/// lifetime or literal.
struct Tok {
    ch: char,
    byte: usize,
    line: usize,
    end_line: usize,
}

/// `None` when the text does not lex.
fn lex(text: &str) -> Option<Vec<Tok>> {
    let s: Vec<(usize, char)> = text.char_indices().collect();
    let at = |k: usize| s.get(k).map(|&(_, c)| c);
    let mut toks = Vec::new();
    let mut open = Vec::new();
    let (mut i, mut line) = (0, 1);
    while let Some(&(byte, c)) = s.get(i) {
        let start = line;
        let mut ch = '\0';
        match c {
            '\n' => {
                line += 1;
                i += 1;
                continue;
            }
            c if c.is_whitespace() => {
                i += 1;
                continue;
            }
            '/' if at(i + 1) == Some('/') => {
                while at(i).is_some_and(|c| c != '\n') {
                    i += 1;
                }
                continue;
            }
            '/' if at(i + 1) == Some('*') => {
                let mut depth = 0;
                loop {
                    match (at(i)?, at(i + 1)) {
                        ('/', Some('*')) => (depth, i) = (depth + 1, i + 2),
                        ('*', Some('/')) => (depth, i) = (depth - 1, i + 2),
                        (c, _) => {
                            line += usize::from(c == '\n');
                            i += 1;
                        }
                    }
                    if depth == 0 {
                        break;
                    }
                }
                continue;
            }
            '"' => i = string(&s, i + 1, 0, &mut line)?,
            '\'' => i = quote(&s, i)?,
            c if c.is_alphanumeric() || c == '_' => {
                let from = i;
                while at(i).is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    i += 1;
                }
                let prefix: String = s[from..i].iter().map(|&(_, c)| c).collect();
                let hashes = s[i..].iter().take_while(|&&(_, c)| c == '#').count();
                if matches!(prefix.as_str(), "r" | "br" | "cr") && at(i + hashes) == Some('"') {
                    i = string(&s, i + hashes + 1, hashes, &mut line)?;
                } else if matches!(prefix.as_str(), "b" | "c") && at(i) == Some('"') {
                    i = string(&s, i + 1, 0, &mut line)?;
                } else if prefix == "b" && at(i) == Some('\'') {
                    i = quote(&s, i)?;
                }
            }
            c => {
                ch = c;
                i += 1;
                match c {
                    '(' | '[' | '{' => open.push(c),
                    ')' => (open.pop()? == '(').then_some(())?,
                    ']' => (open.pop()? == '[').then_some(())?,
                    '}' => (open.pop()? == '{').then_some(())?,
                    _ => {}
                }
            }
        }
        toks.push(Tok {
            ch,
            byte,
            line: start,
            end_line: line,
        });
    }
    open.is_empty().then_some(toks)
}

/// Index just past a string body starting at `i`, closed by `"` plus `hashes`
/// `#`s. Escapes apply only to non-raw strings.
fn string(s: &[(usize, char)], mut i: usize, hashes: usize, line: &mut usize) -> Option<usize> {
    loop {
        match s.get(i)?.1 {
            '\\' if hashes == 0 => {
                *line += usize::from(s.get(i + 1)?.1 == '\n');
                i += 2;
            }
            '"' if s[i + 1..]
                .iter()
                .take(hashes)
                .filter(|&&(_, c)| c == '#')
                .count()
                == hashes =>
            {
                return Some(i + 1 + hashes);
            }
            c => {
                *line += usize::from(c == '\n');
                i += 1;
            }
        }
    }
}

/// Index just past a char literal or lifetime at the `'` at `i`.
fn quote(s: &[(usize, char)], i: usize) -> Option<usize> {
    let at = |k: usize| s.get(k).map(|&(_, c)| c);
    if at(i + 1) == Some('\\') {
        // `'\n'`, `'\''`, `'\u{1F600}'`: skip the escaped char, then find the close.
        let mut k = i + 3;
        while at(k)? != '\'' {
            if at(k)? == '\n' {
                return None;
            }
            k += 1;
        }
        Some(k + 1)
    } else if at(i + 2) == Some('\'') {
        Some(i + 3)
    } else {
        Some(i + 1) // lifetime or label; its name lexes as an identifier
    }
}

/// When `toks[k]` opens an outer attribute that gates its item to test builds,
/// the index of the item's last token.
fn test_item_end(text: &str, toks: &[Tok], k: usize) -> Option<usize> {
    if toks[k].ch != '#' || toks.get(k + 1)?.ch != '[' {
        return None;
    }
    let close = matching(toks, k + 1);
    let attrs = syn::Attribute::parse_outer
        .parse_str(&text[toks[k].byte..=toks[close].byte])
        .ok()?;
    gated_to_test_builds(&attrs).then(|| item_end(toks, close + 1))
}

fn matching(toks: &[Tok], open: usize) -> usize {
    let mut depth = 0usize;
    for (j, tok) in toks.iter().enumerate().skip(open) {
        match tok.ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return j;
                }
            }
            _ => {}
        }
    }
    unreachable!("lex rejects unbalanced delimiters")
}

/// The item after an attribute ends at a `;` or `,` at its own depth, at the
/// close of its first top-level `{ … }` (plus a trailing `;`), or just before
/// the close of the enclosing block (a last field with no comma).
// a `{` in a signature before the body (`Foo<{ N }>`) ends the item
// early; the rest of it then counts, which fails closed.
fn item_end(toks: &[Tok], from: usize) -> usize {
    let mut depth = 0usize;
    for j in from..toks.len() {
        match toks[j].ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' if depth == 0 => return j - 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 && toks[j].ch == '}' {
                    return if toks.get(j + 1).is_some_and(|t| t.ch == ';') {
                        j + 1
                    } else {
                        j
                    };
                }
            }
            ';' | ',' if depth == 0 => return j,
            _ => {}
        }
    }
    toks.len() - 1
}
