pub(crate) fn with_cedar_stack<T>(f: impl FnOnce() -> T) -> T {
    // Cedar needs policy headroom even above the old 512 KiB worker-stack threshold.
    // Nested entry points reuse the expanded stack rather than allocating another.
    stacker::maybe_grow(2 * 1024 * 1024, 4 * 1024 * 1024, f)
}

#[cfg(test)]
#[path = "cedar_stack_tests.rs"]
mod tests;
