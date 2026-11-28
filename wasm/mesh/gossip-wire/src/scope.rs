//! Blob scope: local metadata saying where a stored blob may be replicated.
//!
//! Scope is not part of the envelope, so blob ids do not depend on it. Only
//! [`Scope::LOCAL`] crosses mesh links, as the message a blob travels in
//! (`LocalBlobs` instead of `Blobs`). See `docs/MESH.md`, "Blob scope".

/// A set of scope flags.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Scope(pub u8);

impl Scope {
    /// Replicated on TCP links (every blob on a server).
    pub const INTERNET: Scope = Scope(0b001);
    /// Replicated on mesh links.
    pub const MESH: Scope = Scope(0b010);
    /// Waiting to be uploaded upstream by a bridge.
    pub const UPLOAD: Scope = Scope(0b100);
    /// Local-only: kept in the mesh and never uploaded (no `UPLOAD`, no `INTERNET`),
    /// by this node or a bridge that relays it.
    pub const LOCAL: Scope = Scope(0b1_0000);
    /// No flag.
    pub const NONE: Scope = Scope(0);
    /// Every defined flag. Bit 3 held an `own` flag in development builds (blobs the
    /// local app sent); it is no longer defined and reads as unset.
    const ALL: u8 = 0b1_0111;

    /// Whether every flag of `other` is set.
    pub fn contains(self, other: Scope) -> bool {
        self.0 & other.0 == other.0
    }

    /// Whether any flag of `other` is set.
    pub fn intersects(self, other: Scope) -> bool {
        self.0 & other.0 != 0
    }

    /// Union of both sets.
    pub fn union(self, other: Scope) -> Scope {
        Scope(self.0 | other.0)
    }

    /// `self` without the flags of `other`.
    pub fn without(self, other: Scope) -> Scope {
        Scope(self.0 & !other.0)
    }

    /// The scope encoded by `byte`, ignoring undefined bits.
    pub fn from_byte(byte: u8) -> Scope {
        Scope(byte & Self::ALL)
    }

    /// Whether the blob lives only in the mesh (mesh retention and caps apply).
    pub fn is_mesh_only(self) -> bool {
        self.contains(Scope::MESH) && !self.contains(Scope::INTERNET)
    }

    /// Whether the blob is local-only ([`Scope::LOCAL`]).
    pub fn is_local(self) -> bool {
        self.contains(Scope::LOCAL)
    }

    /// The scope with its invariant restored: a local-only blob never waits for an
    /// upload and is never an internet blob.
    pub fn normalized(self) -> Scope {
        if self.is_local() {
            self.without(Scope::UPLOAD | Scope::INTERNET)
        } else {
            self
        }
    }

    /// The scope of a stored blob (`self`) that arrives again with `incoming`: the
    /// stored copy keeps its class. A local-only blob stays local-only whatever a
    /// later copy claims, and a regular one never becomes local-only (a third party
    /// re-sending it as local must not stop its upload).
    pub fn merged(self, incoming: Scope) -> Scope {
        if self.is_local() {
            self.union(incoming).normalized()
        } else {
            self.union(incoming.without(Scope::LOCAL))
        }
    }
}

impl std::ops::BitOr for Scope {
    type Output = Scope;
    fn bitor(self, rhs: Scope) -> Scope {
        self.union(rhs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_combine() {
        let s = Scope::MESH | Scope::UPLOAD;
        assert!(s.contains(Scope::MESH) && s.contains(Scope::UPLOAD));
        assert!(!s.contains(Scope::INTERNET));
        assert!(s.is_mesh_only());
        assert!(!(s | Scope::INTERNET).is_mesh_only());
        assert_eq!(s.without(Scope::UPLOAD), Scope::MESH);
        assert_eq!(Scope::from_byte(0xff), Scope(0b1_0111));
        assert!(s.intersects(Scope::MESH | Scope::INTERNET));
    }

    #[test]
    fn local_only_never_uploads_and_keeps_its_class() {
        let local = Scope::MESH | Scope::LOCAL;
        assert_eq!(
            (local | Scope::UPLOAD | Scope::INTERNET).normalized(),
            local
        );
        assert!(local.is_mesh_only() && local.is_local());
        // a regular copy of a local blob does not make it uploadable
        assert_eq!(local.merged(Scope::MESH | Scope::UPLOAD), local);
        // a local copy of a regular blob does not stop its upload
        let regular = Scope::MESH | Scope::UPLOAD;
        assert_eq!(regular.merged(Scope::MESH | Scope::LOCAL), regular);
        assert_eq!(Scope::from_byte(local.0), local);
    }
}
