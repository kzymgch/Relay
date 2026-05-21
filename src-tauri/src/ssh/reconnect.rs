//! Exponential-backoff retry policy for SSH auto-reconnect.
//!
//! Pure iterator with no timer dependency so the policy itself is unit-testable
//! without sleeping. The pane's reconnect loop calls `next()` to get the next
//! delay; `None` terminates and the pane transitions to `exited`.
//!
//! Defaults: 250 ms initial, doubled each attempt, capped at 30 s, up to 8
//! attempts total. The cap means very long outages still retry approximately
//! every 30 s instead of growing unboundedly.

use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct BackoffPolicy {
    pub initial: Duration,
    pub factor: f64,
    pub max_delay: Duration,
    pub max_attempts: u32,
}

impl Default for BackoffPolicy {
    fn default() -> Self {
        Self {
            initial: Duration::from_millis(250),
            factor: 2.0,
            max_delay: Duration::from_secs(30),
            max_attempts: 8,
        }
    }
}

impl BackoffPolicy {
    pub fn iter(self) -> BackoffIter {
        BackoffIter {
            policy: self,
            attempt: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BackoffIter {
    policy: BackoffPolicy,
    attempt: u32,
}

impl BackoffIter {
    /// The next retry attempt number (1-based) and the delay to wait before it.
    /// `None` once `max_attempts` is reached.
    pub fn next_attempt(&mut self) -> Option<(u32, Duration)> {
        if self.attempt >= self.policy.max_attempts {
            return None;
        }
        let exp = self.policy.factor.powi(self.attempt as i32);
        let raw_ms = self.policy.initial.as_millis() as f64 * exp;
        let capped_ms = raw_ms.min(self.policy.max_delay.as_millis() as f64);
        self.attempt += 1;
        Some((self.attempt, Duration::from_millis(capped_ms as u64)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_yields_eight_attempts() {
        let mut it = BackoffPolicy::default().iter();
        let mut delays = Vec::new();
        while let Some((_, d)) = it.next_attempt() {
            delays.push(d.as_millis());
        }
        assert_eq!(delays.len(), 8, "8 attempts expected, got {delays:?}");
    }

    #[test]
    fn delays_double_until_capped() {
        // Verifies the exponential ramp and the 30 s cap. Sequence:
        // 250, 500, 1000, 2000, 4000, 8000, 16000, 30000 (capped from 32000).
        let mut it = BackoffPolicy::default().iter();
        let delays: Vec<u128> =
            std::iter::from_fn(|| it.next_attempt().map(|(_, d)| d.as_millis())).collect();
        assert_eq!(delays, vec![250, 500, 1000, 2000, 4000, 8000, 16000, 30000]);
    }

    #[test]
    fn iter_terminates_after_max_attempts() {
        let mut it = BackoffPolicy::default().iter();
        for _ in 0..8 {
            assert!(it.next_attempt().is_some());
        }
        assert!(it.next_attempt().is_none(), "9th call must be None");
        assert!(it.next_attempt().is_none(), "remains None on further calls");
    }

    #[test]
    fn attempts_are_one_based_and_monotonic() {
        // The reconnect UI surfaces `attempt` to the user; 0 would look
        // wrong, and skipping numbers would erode trust.
        let mut it = BackoffPolicy::default().iter();
        let attempts: Vec<u32> = std::iter::from_fn(|| it.next_attempt().map(|(a, _)| a)).collect();
        assert_eq!(attempts, vec![1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn custom_policy_with_zero_attempts_yields_nothing() {
        let policy = BackoffPolicy {
            max_attempts: 0,
            ..Default::default()
        };
        let mut it = policy.iter();
        assert!(it.next_attempt().is_none());
    }
}
