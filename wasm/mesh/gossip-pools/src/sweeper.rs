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
                        if !notify_removed(tx, removed, &stop) {
                            return;
                        }
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "pools sweep failed"),
        }
    }
}

/// Sends the removed ids, or gives up when the thread is asked to stop.
///
/// A plain `send` on a bounded channel that is full blocks until its receiver
/// makes room. A receiver that is alive but not reading would keep the thread
/// there for good, and [`SweeperHandle::stop`] joins the thread. Returns false
/// when the stop signal came first.
fn notify_removed(tx: &Sender<Vec<BlobId>>, removed: Vec<BlobId>, stop: &Receiver<()>) -> bool {
    channel::select! {
        // a receiver that is gone is not an error: nobody listens any more
        send(tx, removed) -> _ => true,
        recv(stop) -> _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn notify_removed_sends_when_there_is_room() {
        let (tx, rx) = channel::bounded(1);
        let (_stop_tx, stop_rx) = channel::bounded::<()>(0);
        assert!(notify_removed(&tx, Vec::new(), &stop_rx));
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn notify_removed_gives_up_on_stop_when_nobody_reads() {
        // full, and its receiver alive but not reading
        let (tx, _rx) = channel::bounded(1);
        tx.send(Vec::new()).unwrap();
        let (stop_tx, stop_rx) = channel::bounded::<()>(0);

        let (done_tx, done_rx) = channel::bounded(1);
        let thread = std::thread::spawn(move || {
            let _ = done_tx.send(notify_removed(&tx, Vec::new(), &stop_rx));
        });
        // still waiting for room
        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());

        drop(stop_tx);
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(5)), Ok(false));
        thread.join().unwrap();
    }
}
