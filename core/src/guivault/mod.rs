//! Client du serveur GuiVault — synchronisation chiffrée de bout en bout du
//! workspace et vaults partagés. Voir le dépôt GuiVault (`docs/ARCHITECTURE.md`
//! et `docs/SECURITY.md`) pour le modèle ; ici, ce que Guiterm en fait :
//!
//! - [`client`] : l'API HTTP, sans cryptographie.
//! - [`account`] : compte sur cette machine (état persistant, session, clés).
//! - [`entity`] : entités du workspace ↔ items chiffrés.
//! - [`sync`] : le moteur de réconciliation.
//! - [`sharing`] : vaults partagés, membres, invitations, empreintes.
//! - [`transfer`] : déplacer des entités entre profil local, vault personnel
//!   et vaults partagés.
//! - [`browse`] : consulter tout le contenu du compte (secrets de l'interface
//!   web compris) pour copier/coller dans un terminal — sans passer par la
//!   synchro.
pub mod account;
pub mod browse;
pub mod client;
pub mod entity;
pub mod sharing;
pub mod sync;
pub mod transfer;

pub use account::{FingerprintTrust, KnownAccount, LoginStep, Manager, Status, VaultSummary};
pub use sync::Report;
