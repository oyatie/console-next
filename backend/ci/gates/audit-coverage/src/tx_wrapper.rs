//! Transaction wrappers (R2 step 0b): a struct that holds a `Transaction<`,
//! such as `PgHrTx`. A method with a `self` receiver on one runs inside the
//! caller's transaction, so it is tx-accepting like a `&mut Transaction<`
//! parameter, and the caller owns the audit.
//!
//! Wrappers are keyed by crate (the path before its last `src`), so a
//! same-named struct elsewhere is not a wrapper. The struct and its `impl`
//! blocks may sit in different files of that crate. Blocks are found on
//! rustfmt'd layout: an `impl` line ends at the next `}` line at its indent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
pub(crate) struct Wrappers(HashSet<(PathBuf, String)>);

impl Wrappers {
    pub(crate) fn collect<'a>(sources: impl IntoIterator<Item = (&'a Path, &'a str)>) -> Self {
        let mut set = HashSet::new();
        for (file, source) in sources {
            for name in wrapper_structs(source) {
                set.insert((crate_root(file), name));
            }
        }
        Self(set)
    }

    /// Byte ranges of `file`'s `impl` blocks whose self type is a wrapper of
    /// its crate.
    pub(crate) fn impl_ranges(&self, file: &Path, source: &str) -> Vec<(usize, usize)> {
        if self.0.is_empty() {
            return Vec::new();
        }
        let root = crate_root(file);
        let mut ranges = Vec::new();
        let mut offset = 0;
        let mut open: Option<(String, usize, String)> = None; // (closing line, start, header)
        for line in source.split_inclusive('\n') {
            let text = line.trim_end_matches(['\n', '\r']);
            match &mut open {
                Some((close, start, header)) => {
                    if !header.contains('{') {
                        header.push(' ');
                        header.push_str(text);
                    }
                    if text == close.as_str() {
                        if self_type(header).is_some_and(|ty| self.0.contains(&(root.clone(), ty)))
                        {
                            ranges.push((*start, offset + line.len()));
                        }
                        open = None;
                    }
                }
                None => {
                    let body = text.trim_start();
                    if body.starts_with("impl") && !body.ends_with('}') {
                        let indent = &text[..text.len() - body.len()];
                        let rest = &body[4..];
                        if rest.starts_with([' ', '<']) {
                            open = Some((format!("{indent}}}"), offset, body.to_owned()));
                        }
                    }
                }
            }
            offset += line.len();
        }
        ranges
    }
}

/// Whether the fn at `offset` is a `self` method inside one of `ranges`.
pub(crate) fn in_receiver(ranges: &[(usize, usize)], offset: usize, signature: &str) -> bool {
    ranges
        .iter()
        .any(|&(start, end)| (start..end).contains(&offset))
        && has_self_receiver(signature)
}

/// Whether the first parameter of `signature` is a `self` receiver.
pub(crate) fn has_self_receiver(signature: &str) -> bool {
    let Some((_, params)) = signature.split_once('(') else {
        return false;
    };
    let first = params.split([',', ')']).next().unwrap_or("");
    let first = first.split(':').next().unwrap_or("").trim();
    first == "self" || first.ends_with(" self") || first.ends_with("&self")
}

/// The path before the last `src` component (the crate dir), or the file.
fn crate_root(file: &Path) -> PathBuf {
    let parts: Vec<_> = file.components().collect();
    match parts.iter().rposition(|part| part.as_os_str() == "src") {
        Some(at) => parts[..at].iter().collect(),
        None => file.to_path_buf(),
    }
}

/// Names of the structs in `source` whose definition mentions `Transaction<`.
/// Only a line that starts a struct item counts (prose saying "struct" does not).
fn wrapper_structs(source: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        let item = line.trim_start();
        let item = match item.strip_prefix("pub") {
            Some(rest) if rest.starts_with('(') => rest.split_once(')').map_or("", |(_, r)| r),
            Some(rest) => rest,
            None => item,
        };
        let Some(after) = item.trim_start().strip_prefix("struct ") else {
            continue;
        };
        let name: String = after
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        // A brace struct ends at its first `}`; a tuple or unit struct at `;`.
        let def = &source[start..];
        let end = match (def.find('{'), def.find(';')) {
            (Some(brace), semi) if semi.is_none_or(|semi| brace < semi) => {
                def[brace..].find('}').map(|e| brace + e)
            }
            (_, semi) => semi,
        }
        .unwrap_or(def.len());
        let compact: String = def[..end].chars().filter(|c| !c.is_whitespace()).collect();
        if !name.is_empty() && compact.contains("Transaction<") {
            names.push(name);
        }
    }
    names
}

/// The self type's last path segment in an `impl` header
/// (`impl<'a> Trait for crate::tx::PgHrTx<'a> {` gives `PgHrTx`).
fn self_type(header: &str) -> Option<String> {
    let mut rest = header.strip_prefix("impl")?.trim_start();
    if rest.starts_with('<') {
        let mut depth = 0usize;
        let close = rest.char_indices().find(|&(_, c)| {
            match c {
                '<' => depth += 1,
                '>' => depth -= 1,
                _ => {}
            }
            depth == 0
        })?;
        rest = &rest[close.0 + 1..];
    }
    let rest = rest.split('{').next()?.split(" where").next()?;
    let ty = rest.rsplit_once(" for ").map_or(rest, |(_, ty)| ty).trim();
    let path: String = ty
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == ':')
        .collect();
    path.rsplit("::")
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const TX: &str = "pub(crate) struct PgHrTx<'a> {\n    tx: &'a mut Transaction<'static, Postgres>,\n}\n\npub struct Plain {\n    pool: PgPool,\n}\n";
    const IMPLS: &str = "impl<'a> PgHrTx<'a> {\n    pub async fn record(&mut self) {\n        sqlx::query(\"INSERT INTO t VALUES (1)\");\n    }\n}\n\nimpl Plain {\n    pub async fn record(&self) {}\n}\n";

    #[test]
    fn finds_wrappers_and_their_impl_blocks_across_files() {
        let tx = Path::new("/w/crates/hr/adapter-postgres/src/tx.rs");
        let exits = Path::new("/w/crates/hr/adapter-postgres/src/exits/write.rs");
        let wrappers = Wrappers::collect([(tx, TX)]);
        let ranges = wrappers.impl_ranges(exits, IMPLS);
        assert_eq!(ranges.len(), 1);
        let (start, end) = ranges[0];
        assert!(IMPLS[start..end].starts_with("impl<'a> PgHrTx<'a>"));
        assert!(!IMPLS[start..end].contains("Plain"));
        // Another crate's `PgHrTx` is not this crate's wrapper.
        let other = Path::new("/w/crates/leave/adapter-postgres/src/lib.rs");
        assert!(wrappers.impl_ranges(other, IMPLS).is_empty());
    }

    #[test]
    fn self_types_and_receivers() {
        assert_eq!(self_type("impl PgHrTx<'_> {").as_deref(), Some("PgHrTx"));
        assert_eq!(
            self_type("impl<'a, T: Into<String>> Write for crate::tx::PgHrTx<'a> where T: Send {")
                .as_deref(),
            Some("PgHrTx")
        );
        assert!(has_self_receiver("pub async fn f(&mut self, id: Uuid)"));
        assert!(has_self_receiver("fn f(&'a mut self)"));
        assert!(has_self_receiver("fn commit(self) -> R"));
        assert!(!has_self_receiver("fn f(pool: &PgPool, myself: u8)"));
        assert!(!has_self_receiver("fn f()"));
    }

    #[test]
    fn tuple_wrappers_count_and_unrelated_structs_do_not() {
        let src = "struct A(Transaction<'static, Postgres>);\nstruct B;\npub struct C { n: u8 }\n// a params struct adds nothing\nfn f(tx: &mut Transaction<'_, Postgres>) {}\n";
        assert_eq!(wrapper_structs(src), ["A"]);
    }

    #[test]
    fn hr_adapters_are_scanned_and_wrapper_methods_are_tx_accepting() {
        let root = std::env::temp_dir().join(format!("audit-hr-surface-{}", std::process::id()));
        let src = root.join("crates/hr/adapter-postgres/src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("tx.rs"), TX).unwrap();
        let unaudited = "pub async fn purge(pool: &PgPool) {\n    sqlx::query(\"DELETE FROM t\").execute(pool).await;\n}\n";
        std::fs::write(src.join("exits.rs"), format!("{IMPLS}\n{unaudited}")).unwrap();
        let result = crate::check_source_tree(&root);
        let flagged: Vec<_> = result
            .violations
            .iter()
            .map(|v| v.function_name.clone())
            .collect();
        assert_eq!(flagged, [Some("purge".to_owned())]);
        assert_eq!(result.examined, 1);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
