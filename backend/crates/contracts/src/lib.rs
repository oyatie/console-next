//! Deterministic OpenAPI composition from per-face fragments.
//!
//! Duplicate paths, operations and components fail. Components are sorted;
//! path order preserves YAML anchor definitions before their aliases.
//!
//! The `$ref` scanner checks recognized local component pointers and rejects
//! unresolved schemas. It scans raw YAML text, so it cannot validate every YAML
//! form; the published document has a parser-based reference gate as well.

pub mod bootstrap_otp_format;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub mod yaml_quotes;

// ---------------------------------------------------------------------------
// Fragment model
// ---------------------------------------------------------------------------

/// One face's contribution to the OpenAPI document.
#[derive(Debug, Clone, Copy)]
pub struct Fragment {
    /// Crate that owns this fragment; used to name both sides of a collision.
    pub source: &'static str,
    pub paths: &'static [PathItem],
    pub schemas: &'static [NamedYaml],
    /// `components/parameters` entries this face owns.
    pub parameters: &'static [NamedYaml],
    /// `components/responses` entries this face owns.
    pub responses: &'static [NamedYaml],
    /// `components/securitySchemes` entries this face owns.
    pub security_schemes: &'static [NamedYaml],
    /// Schemas referenced by this face but supplied outside the composed set.
    /// Every other schema reference must resolve to a composed schema.
    pub external_schemas: &'static [&'static str],
}

/// Document preamble: the `openapi:` version and `info:` block. Owned by the
/// generator's shared fragment, not by any REST face.
#[derive(Debug, Clone, Copy)]
pub struct DocumentPreamble {
    /// Value of the top-level `openapi` field, e.g. `3.1.0`.
    pub openapi: &'static str,
    /// YAML body beneath `info:` (title, version, …) at any indentation.
    pub info: &'static str,
}

/// One path and every operation served on it. A path is owned by exactly one
/// fragment: two faces contributing methods to the same path is a duplicate.
#[derive(Debug, Clone, Copy)]
pub struct PathItem {
    pub path: &'static str,
    pub operations: &'static [Operation],
}

/// One HTTP operation. `body` is the YAML beneath the method key
/// (`operationId`, `responses`, …) at any indentation.
#[derive(Debug, Clone, Copy)]
pub struct Operation {
    pub method: &'static str,
    pub body: &'static str,
}

/// A `components/schemas` entry. `body` is the YAML beneath the schema name.
#[derive(Debug, Clone, Copy)]
pub struct NamedYaml {
    pub name: &'static str,
    pub body: &'static str,
}

// ---------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplicateKind {
    Path,
    Operation,
    Schema,
    Parameter,
    Response,
    SecurityScheme,
}

impl DuplicateKind {
    fn label(self) -> &'static str {
        match self {
            DuplicateKind::Path => "path",
            DuplicateKind::Operation => "operation",
            DuplicateKind::Schema => "schema",
            DuplicateKind::Parameter => "parameter",
            DuplicateKind::Response => "response",
            DuplicateKind::SecurityScheme => "securityScheme",
        }
    }
}

/// A key contributed more than once. `first` and `second` name the owning
/// crates so an operator can route the conflict without reading the fragments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateKey {
    pub kind: DuplicateKind,
    pub key: String,
    pub first: &'static str,
    pub second: &'static str,
}

impl fmt::Display for DuplicateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "duplicate {} key '{}': contributed by both {} and {}",
            self.kind.label(),
            self.key,
            self.first,
            self.second
        )
    }
}

impl std::error::Error for DuplicateKey {}

/// A `$ref` to a schema the composed set does not define and no fragment
/// declares external.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DanglingRef {
    pub schema: String,
    /// Crate whose fragment body contains the ref.
    pub source: &'static str,
}

impl fmt::Display for DanglingRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} refs schema '{}', which no fragment defines and no fragment \
             lists in external_schemas",
            self.source, self.schema
        )
    }
}

impl std::error::Error for DanglingRef {}

/// A reference the composed document cannot follow, whatever the fragment set
/// contains: anything that is not exactly `#/components/<section>/<key>` with a
/// section OpenAPI defines and a legal component key.
///
/// One error rather than one per spelling, because they are one defect. A file
/// or URL prefix, a nested JSON pointer, a missing target, a `#/definitions/…`
/// pointer and a typo of `components` or of a section name are all the same
/// thing: a pointer into something that is not this document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnresolvableRef {
    /// The reference exactly as authored, quotes stripped. From a `$ref` value
    /// or from any other position a pointer is written, such as a
    /// `discriminator.mapping` entry.
    pub value: String,
    /// Crate whose fragment body contains the ref.
    pub source: &'static str,
}

impl fmt::Display for UnresolvableRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} writes the reference `{}`, which the composed document cannot \
             follow: a reference must be exactly '#/components/<section>/<key>', \
             where <section> is one of {} and <key> matches `[A-Za-z0-9._-]+`",
            self.source,
            self.value,
            COMPONENT_SECTIONS.join(", ")
        )
    }
}

impl std::error::Error for UnresolvableRef {}

/// The component sections OpenAPI 3.1 defines, which is the version
/// `backend/openapi/openapi.yaml` declares. Closed by the specification rather
/// than by observation: a section a later OpenAPI version adds is rejected
/// until it is listed here, which is the fail-closed direction.
const COMPONENT_SECTIONS: [&str; 10] = [
    "callbacks",
    "examples",
    "headers",
    "links",
    "parameters",
    "pathItems",
    "requestBodies",
    "responses",
    "schemas",
    "securitySchemes",
];

/// Everything wrong with one composition run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeError {
    pub duplicates: Vec<DuplicateKey>,
    pub unresolvable: Vec<UnresolvableRef>,
    pub dangling: Vec<DanglingRef>,
    /// YAML aliases whose first `*name` appears before the defining `&name`.
    /// Empty when path emit order is sound; fail-closed when a topo bug slips.
    pub yaml_alias_before_anchor: Vec<String>,
    /// A plain (unquoted) scalar holding `: ` — a YAML parser reads it as a
    /// mapping indicator and rejects the document. `line N: text`.
    pub plain_scalar_colon: Vec<String>,
}

impl fmt::Display for ComposeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OpenAPI composition failed:")?;
        for duplicate in &self.duplicates {
            write!(f, "\n  {duplicate}")?;
        }
        for unresolvable in &self.unresolvable {
            write!(f, "\n  {unresolvable}")?;
        }
        for dangling in &self.dangling {
            write!(f, "\n  {dangling}")?;
        }
        for name in &self.yaml_alias_before_anchor {
            write!(
                f,
                "\n  YAML alias *{name} appears before its &{name} anchor"
            )?;
        }
        for line in &self.plain_scalar_colon {
            write!(
                f,
                "\n  plain scalar holds `: ` (quote it or use `>-`): {line}"
            )?;
        }
        Ok(())
    }
}

impl std::error::Error for ComposeError {}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

mod entry;
pub use entry::{compose, compose_document};

fn compose_parts(
    fragments: &[&Fragment],
    preamble: Option<&DocumentPreamble>,
) -> Result<String, ComposeError> {
    // Value carries the owning source so a later collision can name both sides.
    let mut paths: BTreeMap<&str, (&'static str, BTreeMap<String, String>)> = BTreeMap::new();
    let mut schemas: BTreeMap<&str, (&'static str, String)> = BTreeMap::new();
    let mut parameters: BTreeMap<&str, (&'static str, String)> = BTreeMap::new();
    let mut responses: BTreeMap<&str, (&'static str, String)> = BTreeMap::new();
    let mut security_schemes: BTreeMap<&str, (&'static str, String)> = BTreeMap::new();
    let mut duplicates = Vec::new();

    for fragment in fragments {
        for item in fragment.paths {
            let mut operations: BTreeMap<String, String> = BTreeMap::new();
            for operation in item.operations {
                // Lowercase so `GET` and `get` collide instead of both emitting.
                let method = operation.method.to_ascii_lowercase();
                if operations
                    .insert(method.clone(), reindent(operation.body, 6))
                    .is_some()
                {
                    duplicates.push(DuplicateKey {
                        kind: DuplicateKind::Operation,
                        key: format!("{method} {}", item.path),
                        first: fragment.source,
                        second: fragment.source,
                    });
                }
            }

            if let Some((owner, _)) = paths.get(item.path) {
                duplicates.push(DuplicateKey {
                    kind: DuplicateKind::Path,
                    key: item.path.to_owned(),
                    first: owner,
                    second: fragment.source,
                });
                continue;
            }
            paths.insert(item.path, (fragment.source, operations));
        }

        collect_named(
            fragment.source,
            fragment.schemas,
            &mut schemas,
            DuplicateKind::Schema,
            &mut duplicates,
        );
        collect_named(
            fragment.source,
            fragment.parameters,
            &mut parameters,
            DuplicateKind::Parameter,
            &mut duplicates,
        );
        collect_named(
            fragment.source,
            fragment.responses,
            &mut responses,
            DuplicateKind::Response,
            &mut duplicates,
        );
        collect_named(
            fragment.source,
            fragment.security_schemes,
            &mut security_schemes,
            DuplicateKind::SecurityScheme,
            &mut duplicates,
        );
    }

    if !duplicates.is_empty() {
        // Ref resolution needs the complete set, which a collision denies.
        return Err(ComposeError {
            duplicates,
            unresolvable: Vec::new(),
            dangling: Vec::new(),
            yaml_alias_before_anchor: Vec::new(),
            plain_scalar_colon: Vec::new(),
        });
    }

    let mut known_schemas: BTreeSet<&str> = schemas.keys().copied().collect();
    let known_parameters: BTreeSet<&str> = parameters.keys().copied().collect();
    let known_responses: BTreeSet<&str> = responses.keys().copied().collect();
    let known_security: BTreeSet<&str> = security_schemes.keys().copied().collect();
    // Only resolve a non-schema section when this compose run contributed at
    // least one entry to it. A face composed alone still refs shared responses;
    // that is shape-checked and accepted until the shared fragment joins.
    let resolve_parameters = !known_parameters.is_empty();
    let resolve_responses = !known_responses.is_empty();
    let resolve_security = !known_security.is_empty();
    let mut unresolvable = Vec::new();
    let mut dangling = Vec::new();
    for fragment in fragments {
        known_schemas.extend(fragment.external_schemas.iter().copied());
    }
    for fragment in fragments {
        let bodies = fragment
            .paths
            .iter()
            .flat_map(|item| item.operations.iter().map(|operation| operation.body))
            .chain(fragment.schemas.iter().map(|schema| schema.body))
            .chain(fragment.parameters.iter().map(|item| item.body))
            .chain(fragment.responses.iter().map(|item| item.body))
            .chain(fragment.security_schemes.iter().map(|item| item.body));
        for value in bodies.flat_map(ref_values) {
            let Some((section, key)) = component_ref(value) else {
                unresolvable.push(UnresolvableRef {
                    value: value.to_owned(),
                    source: fragment.source,
                });
                continue;
            };
            let dangling_here = match section {
                "schemas" => !known_schemas.contains(key),
                "parameters" => resolve_parameters && !known_parameters.contains(key),
                "responses" => resolve_responses && !known_responses.contains(key),
                "securitySchemes" => resolve_security && !known_security.contains(key),
                // Other OpenAPI component sections are still modeled only as
                // well-formed pointers (Fragment does not own them yet).
                _ => false,
            };
            if dangling_here {
                dangling.push(DanglingRef {
                    schema: key.to_owned(),
                    source: fragment.source,
                });
            }
        }
    }
    if !unresolvable.is_empty() || !dangling.is_empty() {
        return Err(ComposeError {
            duplicates,
            unresolvable,
            dangling,
            yaml_alias_before_anchor: Vec::new(),
            plain_scalar_colon: Vec::new(),
        });
    }

    let mut out = String::new();
    if let Some(preamble) = preamble {
        out.push_str("openapi: ");
        out.push_str(preamble.openapi.trim());
        out.push('\n');
        out.push_str("info:\n");
        out.push_str(&reindent(preamble.info, 2));
    }

    // Paths stay BTree-keyed for collision detection, but emit order is
    // YAML-anchor-aware: anchors before aliases, else lexicographic. Pure lex
    // put `/archive` + `/finalize` (*alias) before `/open` (&anchor).
    out.push_str("paths:\n");
    for path in order_paths_for_yaml_anchors(&paths) {
        let (_, operations) = &paths[path];
        out.push_str(&format!("  {path}:\n"));
        for (method, body) in operations {
            out.push_str(&format!("    {method}:\n"));
            out.push_str(body);
        }
    }

    let has_components = !security_schemes.is_empty()
        || !parameters.is_empty()
        || !responses.is_empty()
        || !schemas.is_empty();
    if has_components {
        out.push_str("components:\n");
        emit_component_section(&mut out, "securitySchemes", &security_schemes);
        emit_component_section(&mut out, "parameters", &parameters);
        emit_component_section(&mut out, "responses", &responses);
        emit_component_section(&mut out, "schemas", &schemas);
    }

    if let Some(name) = first_yaml_alias_before_anchor(&out) {
        return Err(ComposeError {
            duplicates: Vec::new(),
            unresolvable: Vec::new(),
            dangling: Vec::new(),
            yaml_alias_before_anchor: vec![name],
            plain_scalar_colon: Vec::new(),
        });
    }
    if let Some((line, text)) = first_plain_scalar_colon(&out) {
        return Err(ComposeError {
            duplicates: Vec::new(),
            unresolvable: Vec::new(),
            dangling: Vec::new(),
            yaml_alias_before_anchor: Vec::new(),
            plain_scalar_colon: vec![format!("line {line}: {}", text.trim())],
        });
    }

    Ok(out.replace(
        "__BOOTSTRAP_OTP_PATTERN__",
        &bootstrap_otp_format::bootstrap_otp_pattern(),
    ))
}

/// First line (1-based) where a plain — unquoted, non-block — scalar value
/// contains `: `, on the `key: value` line itself or on a continuation line.
/// YAML reads that as a mapping indicator, so the document does not parse
/// (`openapi-typescript` and js-yaml both refuse it). Not a YAML parse — same
/// honesty as [`schema_refs`]: block (`|`/`>`) and quoted/flow values are
/// skipped, and only the one defect class composition has actually shipped is
/// caught.
pub fn first_plain_scalar_colon(doc: &str) -> Option<(usize, &str)> {
    // (column of the key, whether the deeper lines are a plain continuation)
    let mut open: Option<(usize, bool)> = None;
    for (index, line) in doc.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if let Some((key_col, plain)) = open {
            if indent > key_col {
                if plain && has_mapping_indicator(trimmed) {
                    return Some((index + 1, line));
                }
                continue;
            }
            open = None;
        }
        if trimmed.starts_with('#') {
            continue;
        }
        let body = trimmed.strip_prefix("- ").unwrap_or(trimmed);
        let key_col = indent + (trimmed.len() - body.len());
        if body.starts_with(['{', '[']) {
            continue;
        }
        let Some(value) = yaml_quotes::mapping_value(body) else {
            continue;
        };
        match value.chars().next() {
            None | Some('#') => {}
            Some('|' | '>') => open = Some((key_col, false)),
            Some('\'' | '"' | '[' | '{' | '&' | '*' | '!') => {}
            Some(_) => {
                if has_mapping_indicator(value) {
                    return Some((index + 1, line));
                }
                open = Some((key_col, true));
            }
        }
    }
    None
}

fn has_mapping_indicator(text: &str) -> bool {
    let text = text.split(" #").next().unwrap_or(text);
    text.contains(": ") || text.trim_end().ends_with(':')
}

fn collect_named(
    source: &'static str,
    items: &'static [NamedYaml],
    into: &mut BTreeMap<&str, (&'static str, String)>,
    kind: DuplicateKind,
    duplicates: &mut Vec<DuplicateKey>,
) {
    for item in items {
        if let Some((owner, _)) = into.get(item.name) {
            duplicates.push(DuplicateKey {
                kind,
                key: item.name.to_owned(),
                first: owner,
                second: source,
            });
            continue;
        }
        into.insert(item.name, (source, reindent(item.body, 6)));
    }
}

fn emit_component_section(
    out: &mut String,
    section: &str,
    items: &BTreeMap<&str, (&'static str, String)>,
) {
    if items.is_empty() {
        return;
    }
    out.push_str("  ");
    out.push_str(section);
    out.push_str(":\n");
    for (name, (_, body)) in items {
        out.push_str(&format!("    {name}:\n"));
        out.push_str(body);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum YamlNodeIndicator {
    Anchor,
    Alias,
}

/// Scan for YAML node indicators written as `: &name` / `: *name` only.
///
/// This matches how face path bodies author shared response blocks today. It is
/// deliberately not a YAML parse — same honesty as [`schema_refs`].
fn yaml_node_indicators(text: &str) -> Vec<(usize, YamlNodeIndicator, &str)> {
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i + 3 < bytes.len() {
        if bytes[i] == b':'
            && bytes[i + 1] == b' '
            && (bytes[i + 2] == b'&' || bytes[i + 2] == b'*')
        {
            let kind = if bytes[i + 2] == b'&' {
                YamlNodeIndicator::Anchor
            } else {
                YamlNodeIndicator::Alias
            };
            let start = i + 3;
            let mut end = start;
            while end < bytes.len() && is_yaml_anchor_name_byte(bytes[end]) {
                end += 1;
            }
            if end > start {
                out.push((i, kind, &text[start..end]));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn is_yaml_anchor_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// First alias name whose earliest `*name` appears before its `&name`, or whose
/// anchor is missing entirely. `None` means every alias is preceded by its anchor.
pub fn first_yaml_alias_before_anchor(doc: &str) -> Option<String> {
    let mut first_alias: BTreeMap<&str, usize> = BTreeMap::new();
    let mut first_anchor: BTreeMap<&str, usize> = BTreeMap::new();
    for (pos, kind, name) in yaml_node_indicators(doc) {
        match kind {
            YamlNodeIndicator::Alias => {
                first_alias.entry(name).or_insert(pos);
            }
            YamlNodeIndicator::Anchor => {
                first_anchor.entry(name).or_insert(pos);
            }
        }
    }
    for (name, alias_pos) in &first_alias {
        match first_anchor.get(name) {
            Some(anchor_pos) if alias_pos < anchor_pos => return Some((*name).to_owned()),
            None => return Some((*name).to_owned()),
            Some(_) => {}
        }
    }
    None
}

/// Emit paths in an order where YAML anchors precede aliases that reference them.
///
/// Independent paths keep lexicographic order via a `BTreeSet` Kahn ready-set —
/// byte stability for the common case is preserved; only anchor edges reorder.
fn order_paths_for_yaml_anchors<'a>(
    paths: &BTreeMap<&'a str, (&'static str, BTreeMap<String, String>)>,
) -> Vec<&'a str> {
    let mut defines: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let mut uses: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for (path, (_, operations)) in paths {
        let mut defined = BTreeSet::new();
        let mut used = BTreeSet::new();
        for body in operations.values() {
            for (_, kind, name) in yaml_node_indicators(body) {
                match kind {
                    YamlNodeIndicator::Anchor => {
                        defined.insert(name);
                    }
                    YamlNodeIndicator::Alias => {
                        used.insert(name);
                    }
                }
            }
        }
        defines.insert(*path, defined);
        uses.insert(*path, used);
    }

    // First lex path wins if two fragments somehow define the same name.
    let mut anchor_definer: BTreeMap<&str, &str> = BTreeMap::new();
    for (path, names) in &defines {
        for name in names {
            anchor_definer.entry(*name).or_insert(*path);
        }
    }

    let mut successors: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let mut indegree: BTreeMap<&str, usize> = BTreeMap::new();
    for path in paths.keys() {
        successors.insert(*path, BTreeSet::new());
        indegree.insert(*path, 0);
    }
    for (user, names) in &uses {
        for name in names {
            let Some(definer) = anchor_definer.get(name) else {
                continue;
            };
            if definer == user {
                continue;
            }
            if let Some(succ_set) = successors.get_mut(definer)
                && succ_set.insert(*user)
                && let Some(deg) = indegree.get_mut(user)
            {
                *deg += 1;
            }
        }
    }

    let mut ready: BTreeSet<&str> = indegree
        .iter()
        .filter(|(_, deg)| **deg == 0)
        .map(|(path, _)| *path)
        .collect();
    let mut ordered = Vec::with_capacity(paths.len());
    while let Some(path) = ready.iter().next().copied() {
        ready.remove(&path);
        ordered.push(path);
        let Some(succ_set) = successors.get(path) else {
            continue;
        };
        for succ in succ_set.clone() {
            let Some(deg) = indegree.get_mut(succ) else {
                continue;
            };
            *deg -= 1;
            if *deg == 0 {
                ready.insert(succ);
            }
        }
    }

    // Cycle / missing-edge residue: keep lex remainder so emit still totals.
    // [`first_yaml_alias_before_anchor`] then fail-closes if order is still wrong.
    if ordered.len() != paths.len() {
        for path in paths.keys() {
            if !ordered.contains(path) {
                ordered.push(*path);
            }
        }
    }
    ordered
}

/// Every `#/components/schemas/…` key `body` names, from every position a
/// pointer is written — including a `discriminator.mapping` value, which is a
/// schema edge with no `$ref` key on it, so a closure walked with this does not
/// drop the subtypes of a discriminated union.
///
/// Refs into other component sections (`responses`, …) are NOT yielded: they
/// are component references but not schema ones, and [`Fragment`] models only
/// schemas. A caller walking a transitive `$ref` closure with this therefore
/// stops at the boundary of a non-schema component and never enters its body —
/// which is what `console_todos_rest`'s drift test does.
///
/// Neither is anything [`component_ref`] rejects, since such a value names no
/// schema to walk to. This is a resolver, not the control: [`compose`] is what
/// REPORTS an unfollowable `$ref`, and it is the only thing that runs over a
/// fragment before it is published.
///
/// Public so a face's drift test can walk the PUBLISHED document with the same
/// parser [`compose`] uses; a second ref parser in a test is a second source of
/// truth about what a ref is.
pub fn schema_refs(body: &str) -> impl Iterator<Item = &str> {
    ref_values(body).filter_map(|value| match component_ref(value) {
        Some(("schemas", key)) => Some(key),
        _ => None,
    })
}

/// Every reference `body` writes, in document order: first every pointer-shaped
/// scalar, then every block `$ref:` entry whose value carries no pointer.
///
/// Two scans because neither position contains the other, and keying the check
/// on either one alone is a fail-open that the other catches:
///
/// * [`pointer_scalars`] is stated over the VALUE and is therefore blind to no
///   key. A `#/components/…` pointer is not written only after a `$ref` key: a
///   `discriminator.mapping` value is a bare pointer with no `$ref` anywhere
///   near it, and `backend/openapi/openapi.yaml` publishes 27 of those across
///   its 7 `mapping:` blocks today. Neither
///   is `$ref` written only one way — `"$ref":`, `'$ref':` and `$ref :` are all
///   legal YAML and a JSON-converted spec produces the first.
/// * [`ref_entry_values`] is stated over the KEY and is therefore blind to no
///   value. It is the only way to see a ref that contains no `#/components/`
///   pointer to find: `Todo.yaml`, `#/definitions/Todo`, a typo of `components`
///   one segment to the LEFT of the section name.
///
/// The filter is what keeps the two from double-reporting one ref: anything
/// carrying a pointer is already reported, whole, by the first scan.
///
/// NOT total over YAML — two text scans cannot be, and the only total answer is
/// a YAML parser, which is a dependency this crate does not have. What is total
/// is each scan over its own axis: every pointer-shaped scalar is checked in
/// every key position, and every block `$ref:` entry is checked whatever its
/// value. The gap left is their intersection's complement: a `$ref` written
/// inside a flow mapping or continued onto the next line AND carrying no
/// `#/components/` pointer — `[{$ref: Todo.yaml}]` — which no fragment writes
/// today and which `component_ref` would reject if it were seen.
fn ref_values(body: &str) -> impl Iterator<Item = &str> {
    pointer_scalars(body)
        .chain(ref_entry_values(body).filter(|value| !value.contains("#/components/")))
}

/// Every scalar in `body` containing `#/components/`, yielded WHOLE.
///
/// Whole, not from the `#/` onwards, because the prefix is the defect in
/// `common.yaml#/components/schemas/Uuid`: reporting only the tail resolves a
/// foreign-host pointer against the local schema set and publishes it verbatim
/// into every generated client.
///
/// A scalar runs between the YAML tokens that delimit it — a quote, whitespace
/// or a flow-collection delimiter — and NOT to the first character outside
/// `[A-Za-z0-9_]`: component keys are `[A-Za-z0-9._-]+`, so stopping at `.` or
/// `-` would silently resolve `Todo-Summary` against `Todo`.
fn pointer_scalars(body: &str) -> impl Iterator<Item = &str> {
    fn delimits_a_scalar(c: char) -> bool {
        c.is_whitespace() || matches!(c, '\'' | '"' | ',' | '[' | ']' | '{' | '}')
    }
    body.match_indices("#/components/").map(|(at, _)| {
        let start = body[..at]
            .char_indices()
            .rev()
            .find(|(_, c)| delimits_a_scalar(*c))
            .map_or(0, |(index, c)| index + c.len_utf8());
        let end = body[at..]
            .find(delimits_a_scalar)
            .map_or(body.len(), |offset| at + offset);
        &body[start..end]
    })
}

/// The value of every block `$ref:` mapping entry in `body`, quotes stripped.
///
/// The key must OPEN its line, after indentation, `- ` sequence markers and an
/// optional quote around the key itself. That is what separates a reference
/// from a description that happens to contain the characters `$ref:`, which is
/// prose and must compose.
///
/// A `$ref:` with nothing after it on the line yields nothing rather than an
/// empty value: the value is on a following line, where [`pointer_scalars`]
/// sees it, and reporting `` `$ref: ` `` names no ref an author could find.
fn ref_entry_values(body: &str) -> impl Iterator<Item = &str> {
    body.lines().filter_map(|line| {
        let mut head = line.trim_start();
        while let Some(rest) = head.strip_prefix("- ") {
            head = rest.trim_start();
        }
        let head = head.strip_prefix(['\'', '"']).unwrap_or(head);
        let rest = head.strip_prefix("$ref")?;
        let rest = rest.strip_prefix(['\'', '"']).unwrap_or(rest);
        let value = rest.trim_start().strip_prefix(':')?.trim();
        let value = match value.chars().next() {
            Some(quote @ ('\'' | '"')) => value[quote.len_utf8()..]
                .split_once(quote)
                .map_or(&value[quote.len_utf8()..], |(inner, _)| inner),
            _ => {
                let end = value
                    .find(|c: char| c.is_whitespace() || matches!(c, ',' | ']' | '}'))
                    .unwrap_or(value.len());
                &value[..end]
            }
        };
        (!value.is_empty()).then_some(value)
    })
}

/// The `(section, key)` a `$ref` value names, or `None` when the composed
/// document cannot follow it.
///
/// Total over the value rather than over one segment of it: the value must be
/// EXACTLY `#/components/<section>/<key>`, so a file or URL prefix, a nested
/// JSON pointer, a missing target, a foreign pointer dialect and a typo
/// anywhere in the pointer all fail here, by the same rule, without anyone
/// enumerating them.
fn component_ref(value: &str) -> Option<(&str, &str)> {
    let (section, key) = value.strip_prefix("#/components/")?.split_once('/')?;
    let key_is_a_component_key = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    (COMPONENT_SECTIONS.contains(&section) && key_is_a_component_key).then_some((section, key))
}

/// Re-emit `body` at exactly `indent` spaces: strip blank leading/trailing
/// lines, remove the author's common leading indentation, trim trailing
/// whitespace, and terminate every line with `\n`. This is what makes the
/// output independent of how the fragment was written.
fn reindent(body: &str, indent: usize) -> String {
    let lines: Vec<&str> = body
        .lines()
        .map(str::trim_end)
        .skip_while(|line| line.is_empty())
        .collect();
    let end = lines
        .iter()
        .rposition(|line| !line.is_empty())
        .map_or(0, |idx| idx + 1);
    let lines = &lines[..end];

    let common = lines
        .iter()
        .filter(|line| !line.is_empty())
        .map(|line| line.len() - line.trim_start_matches(' ').len())
        .min()
        .unwrap_or(0);

    let pad = " ".repeat(indent);
    let mut out = String::with_capacity(body.len() + lines.len() * indent);
    for line in lines {
        if line.is_empty() {
            out.push('\n');
        } else {
            out.push_str(&pad);
            out.push_str(&line[common..]);
            out.push('\n');
        }
    }
    out
}
