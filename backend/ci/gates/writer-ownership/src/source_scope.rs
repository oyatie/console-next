// SPDX-License-Identifier: LicenseRef-Proprietary
//! Production scope shared by the audit, RLS and writer gates. Names never exempt code.
use crate::crate_tree::{CrateTree, owning_crate};
use crate::gated_to_test_builds;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Remove dev-dependency-only crates and files reachable only through test modules.
/// Unreferenced files and unknown cfg predicates remain scanned (fail closed).
///
/// # Errors
/// Unreadable sources/manifests or unavailable Cargo metadata for a Cargo workspace.
pub fn production_files(root: &Path, sources: Vec<PathBuf>) -> std::io::Result<Vec<PathBuf>> {
    let mut manifests = Vec::new();
    crate::collect_sources(root, &mut Vec::new(), &mut manifests)?;
    let tree = CrateTree::read(root, &manifests)?;
    let sources: Vec<_> = sources
        .into_iter()
        .filter(|path| {
            owning_crate(path, root).is_none_or(|(name, dir)| !tree.is_unshipped(&name, &dir, root))
        })
        .collect();
    let indices: BTreeMap<_, _> = sources
        .iter()
        .enumerate()
        .map(|(index, path)| Ok((path.canonicalize()?, index)))
        .collect::<std::io::Result<_>>()?;
    let mut edges = vec![Vec::new(); sources.len()];
    let mut test_only = BTreeSet::new();
    let mut disabled = BTreeSet::new();
    for (index, path) in sources.iter().enumerate() {
        let text = std::fs::read_to_string(path)?;
        let Ok(file) = syn::parse_file(&text) else {
            continue;
        };
        let parent = path.parent().unwrap_or(root);
        let module_dir = match path.file_stem().and_then(|s| s.to_str()) {
            Some("lib" | "main" | "mod") => parent.to_owned(),
            Some(stem) => parent.join(stem),
            None => parent.to_owned(),
        };
        if gated_to_test_builds(&file.attrs) {
            disabled.insert(index);
            test_only.insert(index);
        }
        module_edges(
            &file.items,
            &module_dir,
            parent,
            false,
            &indices,
            &mut edges[index],
        );
        test_only.extend(
            edges[index]
                .iter()
                .filter(|(_, test)| *test)
                .map(|(i, _)| *i),
        );
    }
    // Test-only parents carry their cfg through unannotated child module files.
    let mut pending: Vec<_> = test_only.iter().copied().collect();
    while let Some(index) = pending.pop() {
        for &(child, _) in &edges[index] {
            if test_only.insert(child) {
                pending.push(child);
            }
        }
    }
    // A second, production reference to the same file wins over a test reference.
    let mut production: BTreeSet<_> = (0..sources.len())
        .filter(|i| !test_only.contains(i))
        .collect();
    let mut pending: Vec<_> = production.iter().copied().collect();
    while let Some(index) = pending.pop() {
        for &(child, test) in &edges[index] {
            if !test && !disabled.contains(&child) && production.insert(child) {
                pending.push(child);
            }
        }
    }
    Ok(sources
        .into_iter()
        .enumerate()
        .filter_map(|(i, path)| production.contains(&i).then_some(path))
        .collect())
}

fn module_edges(
    items: &[syn::Item],
    module_dir: &Path,
    path_dir: &Path,
    test_parent: bool,
    indices: &BTreeMap<PathBuf, usize>,
    edges: &mut Vec<(usize, bool)>,
) {
    for item in items {
        let syn::Item::Mod(module) = item else {
            continue;
        };
        let test = test_parent || gated_to_test_builds(&module.attrs);
        let explicit = module.attrs.iter().find_map(|attr| {
            if !attr.path().is_ident("path") {
                return None;
            }
            let syn::Meta::NameValue(value) = &attr.meta else {
                return None;
            };
            let syn::Expr::Lit(value) = &value.value else {
                return None;
            };
            let syn::Lit::Str(path) = &value.lit else {
                return None;
            };
            Some(path.value())
        });
        let name = module.ident.to_string();
        if let Some((_, items)) = &module.content {
            let dir = explicit.map_or_else(|| module_dir.join(&name), |path| path_dir.join(path));
            module_edges(items, &dir, &dir, test, indices, edges);
        } else {
            let paths = explicit.map_or_else(
                || {
                    vec![
                        module_dir.join(format!("{name}.rs")),
                        module_dir.join(&name).join("mod.rs"),
                    ]
                },
                |path| vec![path_dir.join(path)],
            );
            for path in paths {
                if let Ok(path) = path.canonicalize()
                    && let Some(index) = indices.get(&path)
                {
                    edges.push((*index, test));
                }
            }
        }
    }
}
