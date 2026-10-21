// CONSOLE_URL is the single build-time input for the console origin (no URL literal in source).
// The build fails unless it is an https origin; the runtime override layers live in src/config.rs.
fn main() {
    println!("cargo:rerun-if-env-changed=CONSOLE_URL");
    let raw = std::env::var("CONSOLE_URL").expect(
        "set CONSOLE_URL to the console origin, e.g. https://host (apps/desktop/README.md)",
    );
    let url = url::Url::parse(raw.trim()).expect("CONSOLE_URL is not a URL");
    assert!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none(),
        "CONSOLE_URL must be an https origin without credentials"
    );
    println!(
        "cargo:rustc-env=CONSOLE_DEFAULT_URL={}",
        url.origin().ascii_serialization()
    );
    tauri_build::build()
}
