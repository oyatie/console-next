//! PR-10: `console-app healthcheck`, for a compose `healthcheck:` in an image
//! with no curl. GET `127.0.0.1:<CONSOLE_HTTP_ADDR port>/readyz`; 0 on 200.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(3);

/// The process exit code: 0 when `/readyz` answered 200, else 1.
#[must_use]
pub fn healthcheck() -> i32 {
    let port = std::env::var("CONSOLE_HTTP_ADDR")
        .ok()
        .and_then(|addr| addr.parse::<SocketAddr>().ok())
        .map_or(8080, |addr| addr.port());
    i32::from(!ready(SocketAddr::from(([127, 0, 0, 1], port))))
}

fn ready(addr: SocketAddr) -> bool {
    let probe = || -> std::io::Result<bool> {
        let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT)?;
        stream.set_read_timeout(Some(TIMEOUT))?;
        stream.set_write_timeout(Some(TIMEOUT))?;
        stream
            .write_all(b"GET /readyz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
        let mut head = [0u8; 12];
        stream.read_exact(&mut head)?;
        Ok(head.starts_with(b"HTTP/1.1 200") || head.starts_with(b"HTTP/1.0 200"))
    };
    probe().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn answer(status: &'static str) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 256];
            let n = stream.read(&mut request).unwrap();
            assert!(request[..n].starts_with(b"GET /readyz "));
            stream
                .write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\n\r\n").as_bytes())
                .unwrap();
        });
        addr
    }

    #[test]
    fn ready_only_on_200() {
        assert!(super::ready(answer("200 OK")));
        assert!(!super::ready(answer("503 Service Unavailable")));
        let closed = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        assert!(!super::ready(closed), "nothing listening");
    }
}
