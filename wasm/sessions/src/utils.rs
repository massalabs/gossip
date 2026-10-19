#[cfg(test)]
thread_local! {
    /// Shifts this thread's clock in tests, to simulate peers whose clocks disagree.
    pub(crate) static TEST_CLOCK_OFFSET_MILLIS: std::cell::Cell<i128> =
        const { std::cell::Cell::new(0) };
}

pub(crate) fn timestamp_millis() -> u128 {
    // web_time provides a std::time-compatible API that uses JS Date on wasm32
    // and std::time on native platforms automatically
    let now = web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .expect("Failed to get timestamp")
        .as_millis();
    #[cfg(test)]
    let now = now.saturating_add_signed(TEST_CLOCK_OFFSET_MILLIS.with(|offset| offset.get()));
    now
}
