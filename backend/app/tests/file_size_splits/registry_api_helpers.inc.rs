fn ton_milli(ton: &str) -> Option<i32> {
    ton.strip_suffix('T')
        .and_then(|raw| raw.parse::<f64>().ok())
        .map(|tons| (tons * 1000.0).round() as i32)
}
