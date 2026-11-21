//! Running the seeds of a simulation and reporting them (test only).
//!
//! The three simulations ([`crate::sim`], [`crate::sim_net`], [`crate::sim_groups`]) are
//! ignored by a plain `cargo test`: they run in their own CI job (`groups-simulations.yml`), or
//! locally with
//!
//! ```text
//! cargo test --release -p groups --lib -- --ignored --exact <name>
//! ```
//!
//! where `<name>` is `sim::simulation` (merge), `sim_net::network_simulation` or
//! `sim_groups::membership_simulation`; `-- --ignored simulation` runs all three. Each runs
//! every requested seed, even when some fail, then prints one line per failing seed and one
//! summary line, and fails if any seed failed:
//!
//! ```text
//! SIM-FAIL <simulation> seed=<n> <first line of the failure>
//! SIM-SUMMARY <simulation> seeds=<count> failed=<count> coverage=<ok|missing|unchecked>
//! ```
//!
//! `coverage` says whether every situation the simulation counts occurred over the seeds:
//! `unchecked` for a single seed, too few seeds, or when a seed failed (its counters are lost).
//! A missing situation is also printed as `SIM-FAIL <simulation> coverage <situations>` and
//! fails the test.

use std::any::Any;
use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Runs `run` for every seed, on as many threads as the machine offers, and returns each
/// seed's result in seed order. A seed that panics does not stop the others.
pub(crate) fn run_seeds<C: Send>(
    seeds: &[u64],
    run: impl Fn(u64) -> C + Sync,
) -> BTreeMap<u64, Result<C, String>> {
    let workers = std::thread::available_parallelism()
        .map_or(1, NonZeroUsize::get)
        .min(seeds.len())
        .max(1);
    let next = AtomicUsize::new(0);
    let results = Mutex::new(BTreeMap::new());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&seed) = seeds.get(i) else { return };
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(seed)))
                        .map_err(|p| reason(p.as_ref()));
                    results.lock().unwrap().insert(seed, r);
                }
            });
        }
    });
    results.into_inner().unwrap()
}

/// The first line of a panic's message.
fn reason(panic: &(dyn Any + Send)) -> String {
    let message = if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_owned()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic without a message".to_owned()
    };
    let line = message.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        "panic without a message".to_owned()
    } else {
        line.to_owned()
    }
}

/// Prints the report of a simulation over `seeds` and fails if a seed failed or, when
/// `missing` is given, a counted situation never occurred. `replay` is the command that
/// replays one seed.
pub(crate) fn finish(
    name: &str,
    seeds: usize,
    failures: &[(u64, String)],
    missing: Option<Vec<&'static str>>,
    replay: impl Fn(u64) -> String,
) {
    for (seed, reason) in failures {
        println!("SIM-FAIL {name} seed={seed} {reason}");
    }
    let coverage = match &missing {
        _ if !failures.is_empty() => "unchecked",
        None => "unchecked",
        Some(m) if m.is_empty() => "ok",
        Some(m) => {
            println!("SIM-FAIL {name} coverage situations never exercised: {m:?}");
            "missing"
        }
    };
    println!(
        "SIM-SUMMARY {name} seeds={seeds} failed={} coverage={coverage}",
        failures.len()
    );
    if let Some((seed, _)) = failures.first() {
        let list: Vec<String> = failures.iter().map(|(s, _)| s.to_string()).collect();
        panic!(
            "{name}: {} of {seeds} seeds failed: {}; replay one with {}",
            failures.len(),
            list.join(", "),
            replay(*seed)
        );
    }
    if coverage == "missing" {
        panic!("{name}: situations never exercised: {missing:?}");
    }
}
