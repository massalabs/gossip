//! Background maintenance thread.

use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam::channel::{self, Receiver, RecvTimeoutError, Sender};
use gossip_wire::BlobId;

use crate::pools::Pools;

/// Handle on the sweeper thread started by [`Pools::start_sweeper`].
///
/// [`SweeperHandle::stop`] (or dropping the handle) asks the thread to stop and joins
/// it. The thread also stops by itself once the [`Pools`] it serves is dropped.
#[derive(Debug)]
pub struct SweeperHandle {
    stop: Option<Sender<()>>,
    join: Option<JoinHandle<()>>,
}

impl SweeperHandle {
    pub(crate) fn spawn(
        pools: Weak<Pools>,
        interval: Duration,
        on_removed: Option<Sender<Vec<BlobId>>>,
    ) -> Self {
        let (stop_tx, stop_rx) = channel::bounded::<()>(0);
        let join = std::thread::Builder::new()
            .name("gossip-pools-sweeper".into())
            .spawn(move || run(pools, interval, stop_rx, on_removed))
            .expect("spawn sweeper thread");
        Self {
            stop: Some(stop_tx),
            join: Some(join),
        }
    }

    /// Stops the thread and waits for it to finish the current sweep.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        drop(self.stop.take());
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for SweeperHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run(
    pools: Weak<Pools>,
    interval: Duration,
    stop: Receiver<()>,
    on_removed: Option<Sender<Vec<BlobId>>>,
) {
    loop {
        match stop.recv_timeout(interval) {
            Err(RecvTimeoutError::Timeout) => {}
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
        }
        let Some(pools) = pools.upgrade() else { return };
        let pools: Arc<Pools> = pools;
        match pools.maintain() {
            Ok(removed) => {
                if !removed.is_empty() {
                    tracing::debug!(count = removed.len(), "pools sweep removed blobs");
                    if let Some(tx) = &on_removed {
                        let _ = tx.send(removed);
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "pools sweep failed"),
        }
    }
}
