//! The `cfg(test)` line mask.

/// Mask `cfg(test)` / `cfg(all(test, …))` attribute modules so inline fixture SQL
/// under `app/src/**` does not false-positive as unaudited handlers.
pub(crate) fn compute_test_mask(lines: &[&str]) -> Vec<bool> {
    let mut mask = vec![false; lines.len()];
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i].trim_start();
        if is_cfg_test_attr(l) {
            let mut j = i;
            while j < lines.len() && !lines[j].contains('{') {
                j += 1;
            }
            if j < lines.len() {
                let mut depth = 0i32;
                let mut k = j;
                loop {
                    if k >= lines.len() {
                        break;
                    }
                    for ch in lines[k].chars() {
                        if ch == '{' {
                            depth += 1;
                        } else if ch == '}' {
                            depth -= 1;
                        }
                    }
                    mask[k] = true;
                    if depth <= 0 {
                        break;
                    }
                    k += 1;
                }
                for masked in mask.iter_mut().take(k + 1).skip(i) {
                    *masked = true;
                }
                i = k + 1;
                continue;
            }
        }
        i += 1;
    }
    mask
}

fn is_cfg_test_attr(line: &str) -> bool {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("#[cfg(") {
        return false;
    }
    let bytes = trimmed.as_bytes();
    let needle = b"test";
    let mut idx = 0usize;
    while idx + needle.len() <= bytes.len() {
        if &bytes[idx..idx + needle.len()] == needle {
            let before = idx.checked_sub(1).map(|i| bytes[i]);
            let after = bytes.get(idx + needle.len()).copied();
            let boundary_before = matches!(
                before,
                None | Some(b'(') | Some(b',') | Some(b' ') | Some(b'\t')
            );
            let boundary_after = matches!(
                after,
                None | Some(b')') | Some(b',') | Some(b' ') | Some(b'\t')
            );
            if boundary_before && boundary_after {
                return true;
            }
        }
        idx += 1;
    }
    false
}
