// SPDX-License-Identifier: LicenseRef-Proprietary
use std::path::PathBuf;
use std::process::ExitCode;

fn parse_dir() -> Result<PathBuf, String> {
    let mut args = std::env::args().skip(1);
    let mut dir: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        if arg == "--dir" {
            let val = args
                .next()
                .ok_or_else(|| "OPS_CONFIG_INVALID: --dir requires a path argument".to_owned())?;
            dir = Some(PathBuf::from(val));
        } else if let Some(val) = arg.strip_prefix("--dir=") {
            dir = Some(PathBuf::from(val));
        } else if arg.starts_with('-') {
            return Err(format!("OPS_CONFIG_INVALID: unknown flag {arg}"));
        } else if dir.is_none() {
            dir = Some(PathBuf::from(arg));
        } else {
            return Err(format!(
                "OPS_CONFIG_INVALID: unexpected extra argument {arg}"
            ));
        }
    }
    if let Some(path) = dir {
        return Ok(path);
    }
    if let Ok(env_dir) = std::env::var("CONSOLE_OPS_CONFIG_DIR")
        && !env_dir.trim().is_empty()
    {
        return Ok(PathBuf::from(env_dir));
    }
    Ok(PathBuf::from("/etc/console/ops"))
}

fn main() -> ExitCode {
    let dir = match parse_dir() {
        Ok(dir) => dir,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(78);
        }
    };
    match console_app::validate_ops_bundle_dir(&dir) {
        Ok(cfg) => {
            println!(
                "ops config valid: {} ({} components)",
                cfg.config_dir.display(),
                cfg.components.len()
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::from(78)
        }
    }
}
