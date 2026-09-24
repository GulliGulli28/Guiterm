//! Vaults partagés : création, membres, invitations — avec la vérification
//! d'empreinte comme garde-fou de chaque partage.
//!
//! **Pourquoi l'empreinte est obligatoire.** Le serveur distribue les clés
//! publiques. Un serveur malveillant (ou compromis) pourrait remplacer la clé
//! de Bob par la sienne : Alice envelopperait alors la clé du vault pour le
//! serveur. Rien de cryptographique ne l'en empêche — seule une comparaison
//! de l'empreinte hors bande (de vive voix, sur une messagerie interne) le
//! détecte. D'où [`Manager::require_pinned`] avant toute enveloppe, et le
//! statut de confiance renvoyé au frontend pour qu'il le montre.
use super::account::{FingerprintTrust, Manager, VaultSummary, to_user};
use crate::model::VaultId;
use guivault_crypto as gc;
use guivault_protocol::{self as proto, Invitation, InvitationStatus, Role, VaultMember};
use serde::Serialize;
use uuid::Uuid;

/// Re-télécharge la liste des vaults (après une création, un départ…).
pub async fn refresh_vaults(manager: &Manager) -> anyhow::Result<Vec<VaultSummary>> {
    let client = manager.client()?;
    let remote = to_user(client.sync().await)?;
    manager.update_session(|s| s.absorb_vaults(&remote.vaults))?;
    manager.persist_tokens();
    Ok(manager.status().vaults)
}

pub async fn create_vault(manager: &Manager, name: &str) -> anyhow::Result<VaultSummary> {
    let name = name.trim();
    if name.is_empty() {
        anyhow::bail!("le nom du vault est requis");
    }
    let client = manager.client()?;
    let account = manager.account()?;
    let id = Uuid::new_v4();
    let key = gc::SymmetricKey::random();
    let req = proto::CreateVaultRequest {
        id,
        name_enc: gc::seal_vault_name(&key, &id.to_string(), name)?,
        wrapped_vault_key: gc::wrap_vault_key(&account.keypair, &account.keypair.public, &id.to_string(), &key)?,
    };
    to_user(client.create_vault(&req).await)?;
    let vaults = refresh_vaults(manager).await?;
    vaults
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| anyhow::anyhow!("vault créé mais absent de la liste"))
}

pub async fn rename_vault(manager: &Manager, vault_id: VaultId, name: &str) -> anyhow::Result<()> {
    let name = name.trim();
    if name.is_empty() {
        anyhow::bail!("le nom du vault est requis");
    }
    let client = manager.client()?;
    let v = manager.vault_info(vault_id)?;
    let req = proto::RenameVaultRequest {
        name_enc: gc::seal_vault_name(&v.key, &vault_id.to_string(), name)?,
    };
    to_user(client.rename_vault(vault_id, &req).await)?;
    refresh_vaults(manager).await?;
    Ok(())
}

pub async fn delete_vault(manager: &Manager, vault_id: VaultId) -> anyhow::Result<()> {
    let client = manager.client()?;
    to_user(client.delete_vault(vault_id).await)?;
    refresh_vaults(manager).await?;
    Ok(())
}

pub async fn leave_vault(manager: &Manager, vault_id: VaultId) -> anyhow::Result<()> {
    let client = manager.client()?;
    to_user(client.leave_vault(vault_id).await)?;
    refresh_vaults(manager).await?;
    Ok(())
}

// ─── Utilisateurs et empreintes ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserLookup {
    pub id: Uuid,
    pub email: String,
    pub fingerprint: String,
    pub trust: FingerprintTrust,
}

pub async fn lookup_user(manager: &Manager, email: &str) -> anyhow::Result<Option<UserLookup>> {
    let client = manager.client()?;
    match client.lookup_user(email.trim()).await {
        Ok(u) => Ok(Some(UserLookup {
            trust: manager.fingerprint_trust(&u.email, &u.fingerprint),
            id: u.id,
            email: u.email,
            fingerprint: u.fingerprint,
        })),
        Err(e) if e.code() == Some("not_found") => Ok(None),
        Err(e) => Err(super::account::user_error(e)),
    }
}

// ─── Membres ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub user_id: Uuid,
    pub email: String,
    pub fingerprint: String,
    pub role: Role,
    pub trust: FingerprintTrust,
    pub is_me: bool,
}

pub async fn members(manager: &Manager, vault_id: VaultId) -> anyhow::Result<Vec<MemberView>> {
    let client = manager.client()?;
    let me = manager.with_state(|s| s.user_id)?;
    let list = to_user(client.members(vault_id).await)?;
    Ok(list
        .into_iter()
        .map(|m: VaultMember| MemberView {
            trust: if m.user_id == me {
                FingerprintTrust::Pinned
            } else {
                manager.fingerprint_trust(&m.email, &m.fingerprint)
            },
            is_me: m.user_id == me,
            user_id: m.user_id,
            email: m.email,
            fingerprint: m.fingerprint,
            role: m.role,
        })
        .collect())
}

pub async fn update_member(manager: &Manager, vault_id: VaultId, user_id: Uuid, role: Role) -> anyhow::Result<()> {
    let client = manager.client()?;
    to_user(client.update_member(vault_id, user_id, role).await)
}

/// Retire un membre puis, sauf demande contraire, fait tourner la clé : sans
/// ça, l'ancien membre garde une clé qui ouvre tout ce qui sera écrit ensuite.
pub async fn remove_member(manager: &Manager, vault_id: VaultId, user_id: Uuid, rotate: bool) -> anyhow::Result<()> {
    let client = manager.client()?;
    to_user(client.remove_member(vault_id, user_id).await)?;
    if rotate {
        super::sync::rotate_vault_key(manager, vault_id).await?;
    }
    Ok(())
}

pub async fn transfer_ownership(manager: &Manager, vault_id: VaultId, user_id: Uuid) -> anyhow::Result<()> {
    let client = manager.client()?;
    to_user(client.transfer_ownership(vault_id, user_id).await)?;
    refresh_vaults(manager).await?;
    Ok(())
}

// ─── Invitations ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationView {
    pub id: Uuid,
    pub vault_id: VaultId,
    pub vault_name: Option<String>,
    pub inviter_email: String,
    pub invitee_email: String,
    pub invitee_fingerprint: Option<String>,
    /// Confiance dans l'empreinte de l'invité (côté inviteur, pour compléter).
    pub invitee_trust: Option<FingerprintTrust>,
    pub role: Role,
    pub status: InvitationStatus,
    pub has_key: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

fn view(manager: &Manager, inv: Invitation) -> InvitationView {
    let vault_name = manager.vault_info(inv.vault_id).ok().map(|v| v.name);
    let invitee_trust = inv
        .invitee_fingerprint
        .as_deref()
        .map(|fp| manager.fingerprint_trust(&inv.invitee_email, fp));
    InvitationView {
        id: inv.id,
        vault_id: inv.vault_id,
        vault_name,
        inviter_email: inv.inviter_email,
        invitee_email: inv.invitee_email,
        invitee_fingerprint: inv.invitee_fingerprint,
        invitee_trust,
        role: inv.role,
        status: inv.status,
        has_key: inv.has_key,
        created_at: inv.created_at,
        expires_at: inv.expires_at,
    }
}

/// Invite `email`. S'il a déjà un compte, son empreinte doit avoir été
/// épinglée : la clé du vault est alors enveloppée tout de suite. Sinon
/// l'invitation part sans clé, à compléter après son inscription.
pub async fn invite(manager: &Manager, vault_id: VaultId, email: &str, role: Role) -> anyhow::Result<InvitationView> {
    let client = manager.client()?;
    let vault = manager.vault_info(vault_id)?;
    let email = email.trim().to_lowercase();
    let wrapped = match lookup_user(manager, &email).await? {
        Some(u) => {
            manager.require_pinned(&u.email, &u.fingerprint)?;
            let pk = fetch_public_key(&client, &u.email, &u.fingerprint).await?;
            Some(gc::wrap_vault_key(&manager.account()?.keypair, &pk, &vault_id.to_string(), &vault.key)?)
        }
        None => None,
    };
    let inv = to_user(
        client
            .create_invitation(
                vault_id,
                &proto::CreateInvitationRequest {
                    email,
                    role,
                    wrapped_vault_key: wrapped,
                },
            )
            .await,
    )?;
    Ok(view(manager, inv))
}

/// Récupère la clé publique et vérifie qu'elle correspond bien à l'empreinte
/// qu'on a validée — l'empreinte est ce que l'utilisateur a comparé, la clé
/// est ce qu'on utilise ; les deux doivent être la même chose.
async fn fetch_public_key(client: &super::client::Client, email: &str, fingerprint: &str) -> anyhow::Result<gc::PublicKey> {
    let u = to_user(client.lookup_user(email).await)?;
    let pk = gc::PublicKey::try_from(u.public_key.as_slice()).map_err(|_| anyhow::anyhow!("clé publique de {email} invalide"))?;
    if gc::fingerprint(&pk) != fingerprint {
        anyhow::bail!("la clé publique de {email} ne correspond pas à l'empreinte vérifiée — partage refusé");
    }
    Ok(pk)
}

pub async fn vault_invitations(manager: &Manager, vault_id: VaultId) -> anyhow::Result<Vec<InvitationView>> {
    let client = manager.client()?;
    let list = to_user(client.vault_invitations(vault_id).await)?;
    Ok(list.into_iter().map(|i| view(manager, i)).collect())
}

pub async fn my_invitations(manager: &Manager) -> anyhow::Result<Vec<InvitationView>> {
    let client = manager.client()?;
    let list = to_user(client.my_invitations().await)?;
    Ok(list.into_iter().map(|i| view(manager, i)).collect())
}

pub async fn accept_invitation(manager: &Manager, id: Uuid) -> anyhow::Result<InvitationView> {
    let client = manager.client()?;
    let inv = to_user(client.accept_invitation(id).await)?;
    if inv.status == InvitationStatus::Accepted {
        refresh_vaults(manager).await?;
    }
    Ok(view(manager, inv))
}

pub async fn decline_invitation(manager: &Manager, id: Uuid) -> anyhow::Result<()> {
    let client = manager.client()?;
    to_user(client.decline_invitation(id).await)
}

pub async fn revoke_invitation(manager: &Manager, id: Uuid) -> anyhow::Result<()> {
    let client = manager.client()?;
    to_user(client.revoke_invitation(id).await)
}

/// L'invité s'est inscrit et a accepté : l'inviteur fournit la clé, après
/// avoir épinglé l'empreinte qui apparaît maintenant sur l'invitation.
pub async fn complete_invitation(manager: &Manager, vault_id: VaultId, id: Uuid) -> anyhow::Result<InvitationView> {
    let client = manager.client()?;
    let vault = manager.vault_info(vault_id)?;
    let list = to_user(client.vault_invitations(vault_id).await)?;
    let inv = list
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| anyhow::anyhow!("invitation introuvable"))?;
    let fp = inv
        .invitee_fingerprint
        .clone()
        .ok_or_else(|| anyhow::anyhow!("{} n'a pas encore de compte", inv.invitee_email))?;
    manager.require_pinned(&inv.invitee_email, &fp)?;
    let pk = fetch_public_key(&client, &inv.invitee_email, &fp).await?;
    let done = to_user(
        client
            .complete_invitation(
                id,
                &proto::CompleteInvitationRequest {
                    wrapped_vault_key: gc::wrap_vault_key(&manager.account()?.keypair, &pk, &vault.id.to_string(), &vault.key)?,
                },
            )
            .await,
    )?;
    Ok(view(manager, done))
}

pub async fn audit(manager: &Manager, vault_id: VaultId) -> anyhow::Result<serde_json::Value> {
    let client = manager.client()?;
    to_user(client.vault_audit(vault_id, 200).await)
}

pub async fn sessions(manager: &Manager) -> anyhow::Result<Vec<proto::Session>> {
    let client = manager.client()?;
    to_user(client.sessions().await)
}

pub async fn revoke_session(manager: &Manager, id: Uuid) -> anyhow::Result<()> {
    let client = manager.client()?;
    to_user(client.revoke_session(id).await)
}
