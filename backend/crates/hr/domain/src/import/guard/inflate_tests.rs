//! The counting inflater against hand-built streams: stored blocks, a
//! fixed-Huffman encoder (literals and matches of every length and distance
//! code) and random bytes. Property tests use a seeded xorshift generator
//! (no proptest in this workspace's lock; adding it is a lockfile change).
#![allow(clippy::unwrap_used)]

use super::*;

pub(crate) struct Rng(pub u64);

impl Rng {
    pub(crate) fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    pub(crate) fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[derive(Default)]
pub(crate) struct BitWriter {
    pub out: Vec<u8>,
    acc: u64,
    n: u32,
}

impl BitWriter {
    pub(crate) fn bits(&mut self, value: u32, count: u32) {
        self.acc |= u64::from(value) << self.n;
        self.n += count;
        while self.n >= 8 {
            self.out.push((self.acc & 0xff) as u8);
            self.acc >>= 8;
            self.n -= 8;
        }
    }
    /// A Huffman code, most significant bit first.
    fn code(&mut self, code: u32, len: u32) {
        let reversed = (0..len).fold(0, |r, i| r | (((code >> i) & 1) << (len - 1 - i)));
        self.bits(reversed, len);
    }
    pub(crate) fn finish(mut self) -> Vec<u8> {
        if self.n > 0 {
            self.out.push((self.acc & 0xff) as u8);
        }
        self.out
    }
}

fn fixed_symbol(w: &mut BitWriter, sym: u32) {
    match sym {
        0..=143 => w.code(0x30 + sym, 8),
        144..=255 => w.code(0x190 + sym - 144, 9),
        256..=279 => w.code(sym - 256, 7),
        _ => w.code(0xC0 + sym - 280, 8),
    }
}

/// One fixed-Huffman block of `ops`: `Ok(byte)` a literal, `Err((len, dist))`
/// a match.
pub(crate) fn fixed_block(w: &mut BitWriter, last: bool, ops: &[Result<u8, (u16, u16)>]) {
    w.bits(u32::from(last), 1);
    w.bits(1, 2);
    for op in ops {
        match *op {
            Ok(byte) => fixed_symbol(w, u32::from(byte)),
            Err((len, dist)) => {
                let at = LEN_BASE.iter().rposition(|&b| b <= len).unwrap();
                let at = if len == 258 { 28 } else { at.min(27) };
                fixed_symbol(w, 257 + at as u32);
                w.bits(u32::from(len - LEN_BASE[at]), u32::from(LEN_EXTRA[at]));
                let d = DIST_BASE
                    .iter()
                    .rposition(|&b| b <= u32::from(dist))
                    .unwrap();
                w.code(d as u32, 5);
                w.bits(u32::from(dist) - DIST_BASE[d], u32::from(DIST_EXTRA[d]));
            }
        }
    }
    fixed_symbol(w, 256);
}

/// A deflate stream of one byte then `runs` matches of 258 (≈ 1000:1).
pub(crate) fn bomb(runs: usize) -> Vec<u8> {
    let mut w = BitWriter::default();
    let mut ops = vec![Ok(b'0')];
    ops.extend(std::iter::repeat_n(Err((258, 1)), runs));
    fixed_block(&mut w, true, &ops);
    w.finish()
}

fn stored(chunks: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        out.push(u8::from(i + 1 == chunks.len()));
        let len = chunk.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(chunk);
    }
    out
}

#[test]
fn stored_blocks_count_their_bytes() {
    assert_eq!(inflated_len(&stored(&[b""]), 10), Ok(0));
    assert_eq!(inflated_len(&stored(&[b"abc", b"de"]), 10), Ok(5));
    assert_eq!(
        inflated_len(&stored(&[b"abcdef"]), 5),
        Err(InflateError::Limit)
    );
}

#[test]
fn a_bomb_stops_at_the_limit_without_inflating_it() {
    let stream = bomb(4_000);
    assert!(stream.len() < 8_000);
    assert_eq!(inflated_len(&stream, u64::MAX), Ok(1 + 4_000 * 258));
    assert_eq!(inflated_len(&stream, 10_000), Err(InflateError::Limit));
}

#[test]
fn malformed_streams_are_invalid_not_a_panic() {
    let mut w = BitWriter::default();
    fixed_block(&mut w, true, &[Err((3, 1))]);
    assert_eq!(inflated_len(&w.finish(), 100), Err(InflateError::Invalid));
    let full = bomb(10);
    assert_eq!(
        inflated_len(&full[..full.len() / 2], 1 << 20),
        Err(InflateError::Invalid)
    );
    assert_eq!(inflated_len(&[], 10), Err(InflateError::Invalid));
    assert_eq!(inflated_len(&[0b111], 10), Err(InflateError::Invalid));
}

#[test]
fn property_random_matches_count_exactly() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..500 {
        let (mut ops, mut produced) = (Vec::new(), 0u64);
        for _ in 0..rng.below(200) {
            if produced == 0 || rng.below(3) == 0 {
                ops.push(Ok(rng.below(256) as u8));
                produced += 1;
            } else {
                let len = 3 + rng.below(256) as u16;
                let dist = 1 + rng.below(produced.min(32_768)) as u16;
                ops.push(Err((len, dist)));
                produced += u64::from(len);
            }
        }
        let mut w = BitWriter::default();
        let split = ops.len() / 2;
        fixed_block(&mut w, false, &ops[..split]);
        fixed_block(&mut w, true, &ops[split..]);
        assert_eq!(inflated_len(&w.finish(), u64::MAX), Ok(produced));
    }
}

#[test]
fn property_random_bytes_never_panic_and_respect_the_limit() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    for _ in 0..5_000 {
        let bytes: Vec<u8> = (0..rng.below(64)).map(|_| rng.next() as u8).collect();
        if let Ok(n) = inflated_len(&bytes, 4_096) {
            assert!(n <= 4_096);
        }
    }
}
