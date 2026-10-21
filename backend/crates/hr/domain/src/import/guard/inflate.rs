//! A counting DEFLATE (RFC 1951) decoder: how many bytes a raw deflate stream
//! inflates to, without producing them. The ZIP reader under the workbook
//! parser does not cap its output at the entry's declared size, so a forged
//! central directory could hide a bomb from a declared-size check; this walk
//! counts the real output and stops at `limit` (item 0 of IMPORT-2).
//!
//! No window is kept: a back-reference only adds its length to the count once
//! its distance is checked against what was produced, so memory is constant
//! whatever the input. Pure, total over any input (never panics).

/// Why the stream was not counted to its end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InflateError {
    /// The stream would produce more than `limit` bytes.
    Limit,
    /// Not a valid deflate stream (truncated, bad code, bad distance).
    Invalid,
}

const MAX_BITS: usize = 15;

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    buf: u64,
    count: u32,
}

impl Bits<'_> {
    fn need(&mut self, n: u32) -> Result<u32, InflateError> {
        while self.count < n {
            let byte = *self.data.get(self.pos).ok_or(InflateError::Invalid)?;
            self.pos += 1;
            self.buf |= u64::from(byte) << self.count;
            self.count += 8;
        }
        let value = (self.buf & ((1u64 << n) - 1)) as u32;
        self.buf >>= n;
        self.count -= n;
        Ok(value)
    }
}

/// A canonical Huffman code as counts per length and symbols in code order.
struct Huffman {
    count: [u16; MAX_BITS + 1],
    symbol: Vec<u16>,
}

impl Huffman {
    fn new(lengths: &[u8]) -> Result<Self, InflateError> {
        let mut count = [0u16; MAX_BITS + 1];
        for &len in lengths {
            count[usize::from(len)] += 1;
        }
        let mut left: i32 = 1;
        for &n in &count[1..] {
            left = (left << 1) - i32::from(n);
            if left < 0 {
                return Err(InflateError::Invalid);
            }
        }
        let mut offs = [0u16; MAX_BITS + 1];
        for len in 1..MAX_BITS {
            offs[len + 1] = offs[len] + count[len];
        }
        let mut symbol = vec![0u16; lengths.len()];
        for (sym, &len) in lengths.iter().enumerate() {
            if len != 0 {
                let slot = &mut offs[usize::from(len)];
                symbol[usize::from(*slot)] =
                    u16::try_from(sym).map_err(|_| InflateError::Invalid)?;
                *slot += 1;
            }
        }
        count[0] = 0;
        Ok(Self { count, symbol })
    }

    fn decode(&self, bits: &mut Bits<'_>) -> Result<u16, InflateError> {
        let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
        for len in 1..=MAX_BITS {
            code |= i32::try_from(bits.need(1)?).map_err(|_| InflateError::Invalid)?;
            let n = i32::from(self.count[len]);
            if code - n < first {
                let at =
                    usize::try_from(index + (code - first)).map_err(|_| InflateError::Invalid)?;
                return self.symbol.get(at).copied().ok_or(InflateError::Invalid);
            }
            index += n;
            first = (first + n) << 1;
            code <<= 1;
        }
        Err(InflateError::Invalid)
    }
}

const LEN_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LEN_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u32; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
const CL_ORDER: [usize; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

fn add(out: &mut u64, n: u64, limit: u64) -> Result<(), InflateError> {
    *out += n;
    if *out > limit {
        Err(InflateError::Limit)
    } else {
        Ok(())
    }
}

fn codes(
    bits: &mut Bits<'_>,
    lit: &Huffman,
    dist: &Huffman,
    out: &mut u64,
    limit: u64,
) -> Result<(), InflateError> {
    loop {
        let sym = usize::from(lit.decode(bits)?);
        if sym < 256 {
            add(out, 1, limit)?;
        } else if sym == 256 {
            return Ok(());
        } else {
            let at = sym - 257;
            let (base, extra) = (LEN_BASE.get(at), LEN_EXTRA.get(at));
            let (Some(&base), Some(&extra)) = (base, extra) else {
                return Err(InflateError::Invalid);
            };
            let len = u64::from(base) + u64::from(bits.need(u32::from(extra))?);
            let d = usize::from(dist.decode(bits)?);
            let (Some(&dbase), Some(&dextra)) = (DIST_BASE.get(d), DIST_EXTRA.get(d)) else {
                return Err(InflateError::Invalid);
            };
            let distance = u64::from(dbase) + u64::from(bits.need(u32::from(dextra))?);
            if distance > *out {
                return Err(InflateError::Invalid);
            }
            add(out, len, limit)?;
        }
    }
}

fn fixed() -> Result<(Huffman, Huffman), InflateError> {
    let mut lengths = [0u8; 288];
    for (sym, len) in lengths.iter_mut().enumerate() {
        *len = match sym {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    Ok((Huffman::new(&lengths)?, Huffman::new(&[5u8; 30])?))
}

fn dynamic(bits: &mut Bits<'_>) -> Result<(Huffman, Huffman), InflateError> {
    let nlen = bits.need(5)? as usize + 257;
    let ndist = bits.need(5)? as usize + 1;
    let ncode = bits.need(4)? as usize + 4;
    if nlen > 286 || ndist > 30 {
        return Err(InflateError::Invalid);
    }
    let mut cl = [0u8; 19];
    for &at in &CL_ORDER[..ncode] {
        cl[at] = bits.need(3)? as u8;
    }
    let cl = Huffman::new(&cl)?;
    let mut lengths = vec![0u8; nlen + ndist];
    let mut i = 0;
    while i < lengths.len() {
        let sym = cl.decode(bits)?;
        let (value, repeat) = match sym {
            0..=15 => (sym as u8, 1),
            16 => {
                let prev = *lengths
                    .get(i.wrapping_sub(1))
                    .ok_or(InflateError::Invalid)?;
                (prev, 3 + bits.need(2)? as usize)
            }
            17 => (0, 3 + bits.need(3)? as usize),
            _ => (0, 11 + bits.need(7)? as usize),
        };
        let end = i + repeat;
        let slots = lengths.get_mut(i..end).ok_or(InflateError::Invalid)?;
        slots.fill(value);
        i = end;
    }
    if lengths[256] == 0 {
        return Err(InflateError::Invalid);
    }
    Ok((
        Huffman::new(&lengths[..nlen])?,
        Huffman::new(&lengths[nlen..])?,
    ))
}

/// The number of bytes `data` (a raw deflate stream) inflates to.
///
/// # Errors
/// [`InflateError::Limit`] as soon as the count passes `limit`;
/// [`InflateError::Invalid`] for anything that is not a complete stream.
pub fn inflated_len(data: &[u8], limit: u64) -> Result<u64, InflateError> {
    let mut bits = Bits {
        data,
        pos: 0,
        buf: 0,
        count: 0,
    };
    let mut out = 0u64;
    loop {
        let last = bits.need(1)? == 1;
        match bits.need(2)? {
            0 => {
                bits.buf = 0;
                bits.count = 0;
                let header = data
                    .get(bits.pos..bits.pos + 4)
                    .ok_or(InflateError::Invalid)?;
                let len = u16::from_le_bytes([header[0], header[1]]);
                let nlen = u16::from_le_bytes([header[2], header[3]]);
                if len != !nlen {
                    return Err(InflateError::Invalid);
                }
                bits.pos += 4 + usize::from(len);
                if bits.pos > data.len() {
                    return Err(InflateError::Invalid);
                }
                add(&mut out, u64::from(len), limit)?;
            }
            1 => {
                let (lit, dist) = fixed()?;
                codes(&mut bits, &lit, &dist, &mut out, limit)?;
            }
            2 => {
                let (lit, dist) = dynamic(&mut bits)?;
                codes(&mut bits, &lit, &dist, &mut out, limit)?;
            }
            _ => return Err(InflateError::Invalid),
        }
        if last {
            return Ok(out);
        }
    }
}

#[cfg(test)]
#[path = "inflate_tests.rs"]
pub(crate) mod tests;
