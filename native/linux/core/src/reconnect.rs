//! The reconnect policy: the web's (web/src/player/remote.ts): 500 ms, doubling, at most 10 s; reset on success.
//! A little jitter (up to a fifth) so a restarted server is not hit by every client in the same millisecond.

pub const BASE_MS: u64 = 500;
pub const MAX_MS: u64 = 10_000;

/// The wait before attempt number `attempt` (0 = the first retry), without jitter.
pub fn delay_ms(attempt: u32) -> u64 {
    BASE_MS.saturating_mul(1u64 << attempt.min(16)).min(MAX_MS)
}

/// `delay_ms` plus up to 20 % taken from `r` (0.0..1.0).
pub fn jittered_ms(attempt: u32, r: f64) -> u64 {
    let d = delay_ms(attempt);
    d + (d as f64 * 0.2 * r.clamp(0., 1.)) as u64
}

/// After this many failures in a row the panel says "offline" (the first failure is usually a restart or a blip).
pub const OFFLINE_AFTER: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn doubles_then_caps() {
        let v: Vec<u64> = (0..7).map(delay_ms).collect();
        assert_eq!(v, vec![500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
        assert_eq!(delay_ms(u32::MAX), 10_000, "a huge attempt count does not overflow");
    }
    #[test]
    fn jitter_stays_within_a_fifth() {
        assert_eq!(jittered_ms(0, 0.0), 500);
        assert_eq!(jittered_ms(0, 1.0), 600);
        assert_eq!(jittered_ms(9, 1.0), 12_000);
        assert_eq!(jittered_ms(0, 7.0), 600, "out of range input is clamped");
    }
}
