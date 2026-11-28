// Vendored from massa-protocol-worker/src/handlers/operation_handler/mod.rs and adapted for Gossip.

use std::sync::Arc;
use std::thread::JoinHandle;

use crossbeam::channel::{Receiver, Sender};
use gossip_trust::TrustRegistry;

use crate::config::PropagationConfig;
use crate::events::NetEvent;
use crate::limits::PeerLimitsTable;
use crate::link::Links;
use crate::mesh::MeshParts;
use crate::store::BlobStore;
use crate::trust::PeerTrust;

use self::{
    cache::SharedBlobCache, commands_propagation::PropagationCommand,
    commands_retrieval::RetrievalCommand, propagation::start_propagation_thread,
    retrieval::start_retrieval_thread,
};

pub mod cache;
pub mod commands_propagation;
pub mod commands_retrieval;
mod propagation;
mod retrieval;
pub mod sync;

use crate::events::{PeerManagementCmd, PeerMessageTuple};

pub struct BlobHandler {
    pub retrieval_thread: Option<(Sender<RetrievalCommand>, JoinHandle<()>)>,
    pub propagation_thread: Option<(Sender<PropagationCommand>, JoinHandle<()>)>,
}

impl BlobHandler {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Arc<dyn BlobStore>,
        config: PropagationConfig,
        cache: SharedBlobCache,
        active_connections: Box<dyn Links>,
        receiver_network: Receiver<PeerMessageTuple>,
        (sender_retrieval_ext, receiver_retrieval_ext): (
            Sender<RetrievalCommand>,
            Receiver<RetrievalCommand>,
        ),
        (local_sender, local_receiver): (Sender<PropagationCommand>, Receiver<PropagationCommand>),
        peer_cmd_sender: Sender<PeerManagementCmd>,
        trust: Arc<dyn PeerTrust>,
        registry: Arc<TrustRegistry>,
        events: Sender<NetEvent>,
        limits: PeerLimitsTable,
        mesh: MeshParts,
    ) -> Self {
        let retrieval_thread = start_retrieval_thread(
            receiver_network,
            store.clone(),
            config.clone(),
            cache.clone(),
            active_connections.clone(),
            receiver_retrieval_ext,
            local_sender.clone(),
            peer_cmd_sender,
            trust.clone(),
            registry,
            events,
            limits.clone(),
            mesh.clone(),
        );

        let propagation_thread = start_propagation_thread(
            local_receiver,
            active_connections,
            config,
            cache,
            trust,
            limits,
            store,
            mesh,
        );
        Self {
            retrieval_thread: Some((sender_retrieval_ext, retrieval_thread)),
            propagation_thread: Some((local_sender, propagation_thread)),
        }
    }

    pub fn stop(&mut self) {
        if let Some((tx, thread)) = self.retrieval_thread.take() {
            let _ = tx.send(RetrievalCommand::Stop);
            if thread.join().is_err() {
                tracing::error!("blob retrieval thread panicked");
            }
        }
        if let Some((tx, thread)) = self.propagation_thread.take() {
            let _ = tx.send(PropagationCommand::Stop);
            if thread.join().is_err() {
                tracing::error!("blob propagation thread panicked");
            }
        }
    }
}
