//! Hex SHA-256 used for upload, request and settlement fingerprints.

use std::io::{self, Write};

use serde::Serialize;
use sha2::{Digest, Sha256};

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Hash the serialized bytes without retaining a second copy of the payload.
pub(crate) fn json_sha256_hex(value: &impl Serialize) -> Result<String, serde_json::Error> {
    let mut writer = Sha256Writer(Sha256::new());
    serde_json::to_writer(&mut writer, value)?;
    Ok(hex::encode(writer.0.finalize()))
}

struct Sha256Writer(Sha256);

impl Write for Sha256Writer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
