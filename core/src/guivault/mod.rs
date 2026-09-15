//! Client du serveur GuiVault — synchronisation chiffrée de bout en bout du
//! workspace et vaults partagés. Voir le dépôt GuiVault (`docs/ARCHITECTURE.md`
//! et `docs/SECURITY.md`) pour le modèle ; ici, ce que Guiterm en fait :
//!
//! - [`client`] : l'API HTTP, sans cryptographie.
//! - [`account`] : compte sur cette machine (état persistant, session, clés).
//! - [`entity`] : entités du workspace ↔ items chiffrés.
//! - [`sync`] : le moteur de réconciliation.
//! - [`sharing`] : vaults partagés, membres, invitations, empreintes.
pub mod account;
pub mod client;
pub mod entity;
pub mod sharing;
pub mod sync;

pub use account::{FingerprintTrust, KnownAccount, LoginStep, Manager, Status, VaultSummary};
pub use sync::Report;
