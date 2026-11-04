//! Pairing: a one-time code in a QR code, then a click at the desk.
//!
//! The code is 128 bits, lives five minutes, and is good for one request.
//! Using it doesn't pair anything by itself: the Mac shows who is asking and
//! waits for Allow, so a QR code photographed over a shoulder gets a stranger
//! a "Deny" button, not your agents. Only on Allow is a device token issued,
//! and only its SHA-256 is kept.

use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;

use super::wire::PairDevice;

pub const CODE_TTL_MS: u64 = 5 * 60 * 1000;
/// How long a request waits for Allow or Deny at the Mac.
pub const DECISION_TIMEOUT: Duration = Duration::from_secs(120);
/// Wrong codes within one code's lifetime before the code is burnt.
pub const MAX_FAILURES: u8 = 5;
/// A wrong code is answered this late, as Remote Access does.
pub const WRONG_CODE_DELAY: Duration = Duration::from_millis(400);

/// 128 bits from the OS RNG, base32 without padding (26 characters).
pub fn new_code() -> String {
    let mut bytes = [0u8; 16];
    // As for remote access tokens: no RNG, no safe code, and a predictable
    // one would be worse than refusing.
    #[allow(clippy::expect_used)]
    getrandom::getrandom(&mut bytes).expect("the OS random number generator is unavailable");
    data_encoding::BASE32_NOPAD.encode(&bytes)
}

/// A device token: 256 bits, hex. Shown nowhere; the phone keeps it in its keychain.
pub fn new_token() -> String {
    crate::remote_access::new_token()
}

/// What the Mac stores in place of a token.
pub fn hash_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    crate::remote_access::server::constant_time_eq(a, b)
}

struct ActiveCode {
    code: String,
    expires_at: u64,
    failures: u8,
    used: bool,
}

struct Request {
    device: PairDevice,
    public_key: String,
    decide: oneshot::Sender<bool>,
}

#[derive(Default)]
struct State {
    code: Option<ActiveCode>,
    request: Option<Request>,
}

/// The outcome of presenting a code.
#[derive(Debug)]
pub enum Claim {
    /// No such code (or burnt). Answered with a bare 404 after a delay.
    NoMatch,
    Expired,
    Used,
    /// Waiting for the desk. Resolves `true` on Allow.
    Waiting(oneshot::Receiver<bool>),
}

/// What the Phone panel shows about pairing right now.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    /// A code is out and can still be used.
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    /// A phone used the code and is waiting for Allow or Deny.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<PairDevice>,
}

#[derive(Default)]
pub struct Pairing {
    state: Mutex<State>,
}

impl Pairing {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Issue a new code, replacing any earlier one. A request still waiting
    /// on the old code is denied: the person at the Mac started over.
    pub fn start(&self, now_ms: u64) -> (String, u64) {
        let code = new_code();
        let expires_at = now_ms + CODE_TTL_MS;
        let mut s = self.state();
        if let Some(r) = s.request.take() {
            let _ = r.decide.send(false);
        }
        s.code = Some(ActiveCode {
            code: code.clone(),
            expires_at,
            failures: 0,
            used: false,
        });
        (code, expires_at)
    }

    /// Withdraw the code and deny anything waiting on it.
    pub fn cancel(&self) {
        let mut s = self.state();
        s.code = None;
        if let Some(r) = s.request.take() {
            let _ = r.decide.send(false);
        }
    }

    /// A phone presents `given`. Compared in constant time; wrong guesses
    /// count against the code and burn it at [`MAX_FAILURES`].
    pub fn claim(&self, given: &str, device: PairDevice, public_key: String, now_ms: u64) -> Claim {
        let mut s = self.state();
        let Some(active) = s.code.as_mut() else {
            return Claim::NoMatch;
        };
        if !constant_time_eq(given.trim().as_bytes(), active.code.as_bytes()) {
            active.failures += 1;
            if active.failures >= MAX_FAILURES {
                s.code = None;
            }
            return Claim::NoMatch;
        }
        if active.used {
            return Claim::Used;
        }
        if now_ms > active.expires_at {
            s.code = None;
            return Claim::Expired;
        }
        active.used = true;
        let (tx, rx) = oneshot::channel();
        if let Some(earlier) = s.request.replace(Request {
            device,
            public_key,
            decide: tx,
        }) {
            let _ = earlier.decide.send(false);
        }
        Claim::Waiting(rx)
    }

    /// Allow or Deny at the desk. Returns the device that was waiting, with
    /// its public key, when there was one still listening.
    pub fn decide(&self, allow: bool) -> Option<(PairDevice, String)> {
        let mut s = self.state();
        // The code stays, marked used, so a second scan hears "already used".
        let request = s.request.take()?;
        let device = request.device.clone();
        let key = request.public_key.clone();
        request.decide.send(allow).ok().map(|_| (device, key))
    }

    /// The phone gave up waiting (timeout or disconnect).
    pub fn abandon(&self) {
        let mut s = self.state();
        if s.request.as_ref().is_some_and(|r| r.decide.is_closed()) {
            s.request = None;
        }
    }

    /// Whether a code is out, and who is waiting at the desk.
    pub fn view(&self, now_ms: u64) -> PairingView {
        let s = self.state();
        let code = s
            .code
            .as_ref()
            .filter(|c| !c.used && now_ms <= c.expires_at);
        PairingView {
            active: code.is_some(),
            expires_at: code.map(|c| c.expires_at),
            request: s
                .request
                .as_ref()
                .filter(|r| !r.decide.is_closed())
                .map(|r| r.device.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::wire::{BuildKind, DevicePlatform};

    fn phone() -> PairDevice {
        PairDevice {
            name: "Julian’s iPhone".into(),
            platform: DevicePlatform::Ios,
            model: Some("iPhone 16".into()),
            app_version: "1.0.0".into(),
            build: BuildKind::Official,
        }
    }

    #[test]
    fn codes_are_128_bit_base32() {
        let a = new_code();
        assert_eq!(a.len(), 26);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c)));
        assert_ne!(a, new_code());
    }

    #[test]
    fn tokens_are_stored_as_sha256_only() {
        let token = new_token();
        assert_eq!(token.len(), 64);
        let hash = hash_token(&token);
        assert_eq!(hash.len(), 64);
        assert_ne!(hash, token);
        assert_eq!(hash, hash_token(&token), "deterministic");
        assert_ne!(hash, hash_token(&new_token()));
        // A known vector, so the scheme can't drift silently.
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[tokio::test]
    async fn a_code_works_once_and_only_after_allow() {
        let p = Pairing::default();
        let (code, expires) = p.start(1_000);
        assert_eq!(expires, 1_000 + CODE_TTL_MS);
        let Claim::Waiting(rx) = p.claim(&code, phone(), "pk".into(), 2_000) else {
            panic!("expected to wait for the desk")
        };
        assert!(matches!(
            p.claim(&code, phone(), "pk".into(), 2_001),
            Claim::Used
        ));
        let view = p.view(2_002);
        assert!(!view.active, "a used code isn't offered again");
        assert_eq!(view.request.unwrap().name, "Julian’s iPhone");
        let (device, key) = p.decide(true).unwrap();
        assert_eq!(device.name, "Julian’s iPhone");
        assert_eq!(key, "pk");
        assert!(rx.await.unwrap());
        assert!(matches!(
            p.claim(&code, phone(), "pk".into(), 2_003),
            Claim::Used
        ));
    }

    #[tokio::test]
    async fn deny_and_cancel_say_no() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        let Claim::Waiting(rx) = p.claim(&code, phone(), String::new(), 1) else {
            panic!()
        };
        assert!(p.decide(false).is_some());
        assert!(!rx.await.unwrap());

        let (code, _) = p.start(0);
        let Claim::Waiting(rx) = p.claim(&code, phone(), String::new(), 1) else {
            panic!()
        };
        p.cancel();
        assert!(!rx.await.unwrap());
    }

    #[test]
    fn codes_expire_after_five_minutes() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        assert!(!p.view(CODE_TTL_MS + 1).active);
        assert!(matches!(
            p.claim(&code, phone(), String::new(), CODE_TTL_MS + 1),
            Claim::Expired
        ));
    }

    #[test]
    fn five_wrong_codes_burn_the_real_one() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        for _ in 0..MAX_FAILURES {
            assert!(matches!(
                p.claim("WRONGWRONGWRONGWRONGWRONGW", phone(), String::new(), 1),
                Claim::NoMatch
            ));
        }
        assert!(matches!(
            p.claim(&code, phone(), String::new(), 2),
            Claim::NoMatch
        ));
    }

    #[test]
    fn a_new_code_replaces_the_old_one() {
        let p = Pairing::default();
        let (old, _) = p.start(0);
        let (new, _) = p.start(0);
        assert!(matches!(
            p.claim(&old, phone(), String::new(), 1),
            Claim::NoMatch
        ));
        assert!(matches!(
            p.claim(&new, phone(), String::new(), 1),
            Claim::Waiting(_)
        ));
    }

    #[test]
    fn a_phone_that_stopped_waiting_isnt_shown() {
        let p = Pairing::default();
        let (code, _) = p.start(0);
        let Claim::Waiting(rx) = p.claim(&code, phone(), String::new(), 1) else {
            panic!()
        };
        drop(rx);
        assert!(p.view(2).request.is_none());
        assert!(p.decide(true).is_none(), "nobody to allow");
    }
}
