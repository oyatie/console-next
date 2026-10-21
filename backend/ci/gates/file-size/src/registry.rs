use console_gate_file_size::{BASELINE, Counts, cap, parse_baseline, render_baseline};
use std::collections::BTreeSet;
use std::path::Path;

pub(super) const DIRECTORY: &str = "ci/gates/file-size/baseline.d";

pub(super) fn merge(
    mut pins: Counts,
    contributions: Vec<(String, Counts)>,
) -> Result<Counts, String> {
    let mut seen = BTreeSet::new();
    for (lane, entries) in contributions {
        for (path, count) in entries {
            if !seen.insert(path.clone()) {
                return Err(format!("{lane}: overlapping baseline entry {path}"));
            }
            if pins.get(&path).is_none_or(|old| count > *old) {
                return Err(format!(
                    "{lane}: a baseline contribution may only lower an existing pin: {path}"
                ));
            }
            if count <= cap(&path) {
                pins.remove(&path);
            } else {
                pins.insert(path, count);
            }
        }
    }
    Ok(pins)
}

pub(super) fn read(root: &Path, pins: Counts) -> Result<Counts, String> {
    let directory = root.join(DIRECTORY);
    let files = match std::fs::read_dir(directory) {
        Ok(files) => files,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(pins),
        Err(error) => return Err(error.to_string()),
    };
    let mut contributions = Vec::new();
    for file in files {
        let path = file.map_err(|error| error.to_string())?.path();
        if path.extension().is_some_and(|extension| extension == "txt") {
            let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
            contributions.push((path.display().to_string(), parse_baseline(&text)?));
        }
    }
    merge(pins, contributions)
}

pub(super) fn clear(root: &Path) -> Result<(), String> {
    let directory = root.join(DIRECTORY);
    if directory.exists() {
        for file in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
            let path = file.map_err(|error| error.to_string())?.path();
            if path.extension().is_some_and(|extension| extension == "txt") {
                std::fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

pub(super) fn write_lane(root: &Path, lane: &str, counts: &Counts) -> Result<(), String> {
    if lane.is_empty()
        || !lane
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err("lane must be a safe file name".into());
    }
    let base = parse_baseline(
        &std::fs::read_to_string(root.join(BASELINE)).map_err(|error| error.to_string())?,
    )?;
    let changed = super::git(root, &["diff", "--name-only", "dev"])?;
    if !changed.status.success() {
        return Err("cannot inspect lane diff".into());
    }
    let paths: BTreeSet<_> = String::from_utf8_lossy(&changed.stdout)
        .lines()
        .filter_map(|path| path.strip_prefix("backend/").map(str::to_owned))
        .collect();
    let entries: Counts = base
        .iter()
        .filter(|(path, _)| paths.contains(*path))
        .filter_map(|(path, old)| {
            let count = counts.get(path).copied().unwrap_or(0);
            (count < *old).then(|| (path.clone(), count))
        })
        .collect();
    merge(base, vec![(lane.into(), entries.clone())])?;
    let directory = root.join(DIRECTORY);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::fs::write(
        directory.join(format!("{lane}.txt")),
        render_baseline(&entries),
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contributions_reduce_or_remove_pins_and_refuse_raise_new_or_overlap() {
        let pins = Counts::from([("app/a.rs".into(), 400), ("app/b.rs".into(), 500)]);
        let reduced = merge(
            pins.clone(),
            vec![("lane".into(), Counts::from([("app/a.rs".into(), 300)]))],
        );
        assert_eq!(reduced, Ok(Counts::from([("app/b.rs".into(), 500)])));
        for entries in [
            Counts::from([("app/a.rs".into(), 401)]),
            Counts::from([("app/new.rs".into(), 400)]),
        ] {
            assert!(merge(pins.clone(), vec![("lane".into(), entries)]).is_err());
        }
        assert!(
            merge(
                pins,
                vec![
                    ("a".into(), Counts::from([("app/a.rs".into(), 350)])),
                    ("b".into(), Counts::from([("app/a.rs".into(), 340)]))
                ]
            )
            .is_err()
        );
    }
}
