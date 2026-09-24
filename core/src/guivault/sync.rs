//! Le moteur de synchronisation : réconcilie le workspace local avec les
//! vaults du serveur.
//!
//! Le workspace vit derrière un `std::sync::Mutex` dans la couche Tauri, qu'on
//! ne peut pas garder à travers des `await`. D'où le découpage :
//! 1. l'appelant prend une **copie** du workspace ;
//! 2. [`run`] fait tout le réseau et la cryptographie dessus, et rend une
//!    liste de [`Change`] ;
//! 3. l'appelant reprend le verrou, [`apply_changes`] les joue, et sauve.
//!
//! Une modification faite par l'utilisateur entre 1 et 3 sur la même entité
//! est écrasée par la version synchronisée — la synchro suivante la renvoie.
//!
//! Règles de fusion, volontairement simples et prévisibles :
//! - une entité modifiée **des deux côtés** depuis la dernière synchro : la
//!   version locale gagne (poussée avec la révision courante du serveur), et
//!   le rapport le dit ;
//! - une entité supprimée en face mais modifiée ici : recréée en face ;
//! - une entité liée à un vault qu'on ne voit plus (quitté, supprimé, accès
//!   retiré) : retirée d'ici, ce n'est plus la nôtre.
use super::account::{ItemState, Manager, VaultRollback};
use super::client::{Client, ClientError};
use super::entity::{self, LocalEntity, Payload};
use crate::model::{VaultId, Workspace};
use guivault_crypto as gc;
use guivault_protocol::{self as proto, Item, VaultKind};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Une modification à jouer sur le workspace en mémoire.
#[derive(Debug)]
pub enum Change {
    Upsert { payload: Box<Payload>, vault: Option<VaultId> },
    Remove { item_type: String, id: Uuid },
    /// Même contenu, autre vault : seule l'affiliation change.
    Rebind { id: Uuid, vault: Option<VaultId> },
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub pulled: usize,
    /// Ce qui a été reçu, par nom de vault — pour le dire (« 3 reçus
    /// d'Équipe infra ») plutôt que de changer l'arbre en silence.
    pub pulled_by_vault: std::collections::BTreeMap<String, usize>,
    pub pushed: usize,
    pub removed_locally: usize,
    pub deleted_remotely: usize,
    /// Entités modifiées des deux côtés — la version locale a gagné.
    pub conflicts: Vec<String>,
    /// Entités non poussées (vault en lecture seule, chiffré illisible…).
    pub warnings: Vec<String>,
    pub pending_invitations: usize,
}

fn label_of(json: &str) -> String {
    Payload::from_json(json.as_bytes())
        .map(|p| match p {
            Payload::Host { host, .. } => format!("hôte « {} »", host.label),
            Payload::Group { group } => format!("groupe « {} »", group.name),
            Payload::Snippet { snippet } => format!("snippet « {} »", snippet.name),
            Payload::Key { key, .. } => format!("clé « {} »", key.name),
            Payload::SqlConnection { connection, .. } => format!("connexion « {} »", connection.label),
            Payload::Icon { icon } => format!("icône « {} »", icon.name),
            Payload::Runbook { runbook } => format!("runbook « {} »", runbook.name),
        })
        .unwrap_or_else(|_| "entité".to_string())
}

/// Sur un 409 `revision_mismatch` : `Some(item courant)`, ou `Some(None)`
/// quand le serveur n'a pas du tout l'item (base restaurée d'avant sa
/// création) — on le recrée.
fn conflict_current(e: &ClientError) -> Option<Option<Item>> {
    match e {
        ClientError::Api { code, body, .. } if code == "revision_mismatch" => Some(serde_json::from_value(body["current"].clone()).ok()),
        _ => None,
    }
}

/// À incrémenter quand les règles de fusion changent de façon à ce qu'un
/// état déjà « à jour » doive être relu (2 : résolution d'une entité
/// présente dans deux vaults ; 3 : les runbooks, jusque-là ignorés — ceux
/// déjà écrits par l'interface web doivent être relus).
pub const SYNC_FORMAT: u32 = 3;

pub async fn run(manager: &Manager, snapshot: &Workspace) -> anyhow::Result<(Vec<Change>, Report)> {
    let client = manager.client()?;
    let _account = manager.account()?;
    let mut report = Report::default();

    let remote = client.sync().await.map_err(super::account::user_error)?;
    manager.update_session(|s| s.absorb_vaults(&remote.vaults))?;
    report.pending_invitations = remote.invitations.len();

    let vaults: HashMap<VaultId, _> = manager.vault_infos().into_iter().map(|v| (v.id, v)).collect();
    let personal = vaults
        .values()
        .find(|v| v.kind == VaultKind::Personal)
        .ok_or_else(|| anyhow::anyhow!("ce compte n'a pas de vault personnel"))?
        .clone();

    let mut state = manager.with_state(|s| s.sync.clone())?;
    if state.format < SYNC_FORMAT {
        state.vault_revisions.clear();
        state.format = SYNC_FORMAT;
    }
    let mut changes = Vec::new();

    // ─── Retour en arrière ───────────────────────────────────────────────
    // Le serveur ne fait que monter la révision d'un vault. S'il en annonce
    // une plus basse que celle déjà vue d'ici, le vault est suspendu jusqu'à
    // ce que l'utilisateur reprenne (`Manager::resume_after_rollback`) :
    // sinon `?since=` sauterait en silence tout ce qui s'écrit ensuite sous
    // des révisions déjà « vues », et de vieilles versions pourraient
    // remplacer celles d'ici.
    state.rollbacks.retain(|id, _| vaults.contains_key(id));
    state.resuming.retain(|id| vaults.contains_key(id));
    for v in vaults.values() {
        if let Some(&known) = state.vault_revisions.get(&v.id)
            && v.revision < known
            && !state.rollbacks.contains_key(&v.id)
        {
            report.warnings.push(format!(
                "le vault « {} » est revenu en arrière sur le serveur (révision {}, alors que {known} a déjà été vue d'ici) : \
                 sa synchronisation est suspendue, voir le panneau GuiVault",
                v.name, v.revision
            ));
            state.rollbacks.insert(
                v.id,
                VaultRollback {
                    vault_id: v.id,
                    name: v.name.clone(),
                    known,
                    seen: v.revision,
                    detected_at: chrono::Utc::now(),
                },
            );
        }
    }
    let frozen: HashSet<VaultId> = state.rollbacks.keys().copied().collect();

    // ─── Vue locale ──────────────────────────────────────────────────────
    let mut locals: HashMap<Uuid, LocalEntity> = entity::collect(snapshot, personal.id)?
        .into_iter()
        .map(|e| (e.id, e))
        .collect();

    // Entités liées à un vault qu'on ne voit plus : elles partent.
    let orphans: Vec<Uuid> = locals
        .values()
        .filter(|e| !vaults.contains_key(&e.vault_id))
        .map(|e| e.id)
        .collect();
    for id in orphans {
        let e = locals.remove(&id).expect("vient d'être listée");
        changes.push(Change::Remove {
            item_type: e.item_type.to_string(),
            id,
        });
        state.items.remove(&id);
        report.removed_locally += 1;
        report.warnings.push(format!("{} retiré : plus d'accès à son vault", label_of(&e.json)));
    }

    // ─── Pull ────────────────────────────────────────────────────────────
    // Ordre stable : une entité déplacée a une tombale dans un vault et une
    // version vivante dans un autre, et l'ordre de traitement ne doit pas
    // changer le résultat d'une exécution à l'autre.
    let mut ordered: Vec<_> = vaults.values().collect();
    ordered.sort_by_key(|v| v.id);
    for v in ordered {
        if frozen.contains(&v.id) {
            continue;
        }
        // Reprise après un retour en arrière : le vault est relu en entier
        // (`vault_revisions` oublié) et ce que ce poste connaît y fait foi —
        // sauf en lecture seule, où il n'y a rien à renvoyer : le serveur
        // l'emporte, comme à une première synchro.
        let resuming = state.resuming.remove(&v.id);
        if resuming && !v.role.can_write_items() {
            state.items.retain(|_, s| s.vault_id != v.id);
        }
        let known = state.vault_revisions.get(&v.id).copied();
        if known.is_some_and(|k| k >= v.revision) {
            continue;
        }
        let page = client.items(v.id, known).await.map_err(super::account::user_error)?;
        for item in page.items {
            // Les secrets de l'interface web de GuiVault (identifiants,
            // notes, cartes, identités — `guivault-items`) : ce client ne
            // les affiche pas encore, et surtout ne doit pas les toucher.
            // Ni avertissement, ni état de synchro — un item qui entrerait
            // dans `state.items` sans exister localement serait pris pour
            // une suppression locale et effacé en face à la synchro
            // suivante. Le jour où Guiterm les range quelque part, c'est
            // ici que ça commence (`docs/ITEMS.md` côté GuiVault).
            if guivault_items::SecretItem::is_secret_type(&item.item_type) {
                continue;
            }
            // Copie : la boucle modifie `locals` plus bas.
            let local = locals.get(&item.id).cloned();
            let local = local.as_ref();
            let st = state.items.get(&item.id).cloned();
            let st = st.as_ref();
            let local_modified = local.is_some_and(|l| st.is_none_or(|s| s.hash != l.hash));

            if resuming && let Some(s) = st {
                // Rangée ici dans un autre vault : la copie de celui-ci date
                // d'avant le déplacement (sa tombale est perdue) — elle part.
                if s.vault_id != v.id {
                    if v.role.can_write_items() {
                        match client.delete_item(v.id, item.id).await {
                            Ok(()) => report.deleted_remotely += 1,
                            Err(e) if e.code() == Some("not_found") => {}
                            Err(e) => return Err(super::account::user_error(e)),
                        }
                    }
                    continue;
                }
                // Supprimée ici : la phase de suppression s'en charge, elle
                // ne revient pas.
                if local.is_none() {
                    continue;
                }
            }

            if item.deleted {
                // Une tombale ne concerne que l'entité qui vit dans *ce*
                // vault : après un déplacement, l'ancien vault en garde une
                // qui ne doit pas effacer la version reçue du nouveau.
                if local.is_some_and(|l| l.vault_id != v.id) {
                    continue;
                }
                if local_modified {
                    // Recréée par la phase de push (plus d'état → « nouvelle »).
                    state.items.remove(&item.id);
                    report.conflicts.push(format!(
                        "{} supprimé en face mais modifié ici : recréé",
                        label_of(&local.expect("local_modified").json)
                    ));
                } else {
                    if local.is_some() {
                        changes.push(Change::Remove {
                            item_type: item.item_type.clone(),
                            id: item.id,
                        });
                        locals.remove(&item.id);
                        report.removed_locally += 1;
                    }
                    state.items.remove(&item.id);
                }
                continue;
            }

            let plain = match gc::open_item(&v.key, &v.id.to_string(), &item.id.to_string(), &item.item_type, &item.ciphertext) {
                Ok(p) => p,
                Err(e) => {
                    report.warnings.push(format!("item {} du vault « {} » illisible : {e}", item.id, v.name));
                    continue;
                }
            };
            let payload = match Payload::from_json(&plain) {
                Ok(p) if p.id() == item.id && p.item_type() == item.item_type => p,
                Ok(_) => {
                    report.warnings.push(format!("item {} : contenu incohérent avec son identité, ignoré", item.id));
                    continue;
                }
                Err(e) => {
                    report.warnings.push(format!("item {} : JSON invalide ({e}), ignoré", item.id));
                    continue;
                }
            };

            let json = payload.to_json()?;
            let hash = entity::hash(&json);

            // Une entité ne vit que dans un vault. Si elle arrive de V alors
            // qu'elle est rangée ici dans W, on suit V — sauf si V est le
            // vault personnel et W un vault partagé : une copie personnelle
            // ne rétrograde jamais une entité partagée (c'est ce qui arrive
            // quand un compte se connecte sur une machine où l'entité a été
            // détachée). Dans les deux cas, la copie personnelle en trop est
            // supprimée en face : deux exemplaires, c'est un de trop.
            let mut same_content = local.is_some_and(|l| l.hash == hash);
            if let Some(l) = local.cloned()
                && l.vault_id != v.id
            {
                let w_shared = vaults.get(&l.vault_id).is_some_and(|w| w.kind == VaultKind::Shared);
                if v.kind == VaultKind::Personal && w_shared {
                    match client.delete_item(v.id, item.id).await {
                        Ok(()) => report.deleted_remotely += 1,
                        Err(e) if e.code() == Some("not_found") => {}
                        Err(e) => return Err(super::account::user_error(e)),
                    }
                    continue;
                }
                if l.vault_id == personal.id {
                    match client.delete_item(personal.id, item.id).await {
                        Ok(()) => report.deleted_remotely += 1,
                        Err(e) if e.code() == Some("not_found") => {}
                        Err(e) => return Err(super::account::user_error(e)),
                    }
                }
                let vault = (v.kind != VaultKind::Personal).then_some(v.id);
                if same_content {
                    changes.push(Change::Rebind { id: item.id, vault });
                    if let Some(entry) = locals.get_mut(&item.id) {
                        entry.vault_id = v.id;
                    }
                } else {
                    // Contenu différent : la version du vault suivi est la
                    // référence, le reste du chemin l'applique.
                    same_content = false;
                    state.items.remove(&item.id);
                }
            }
            if same_content {
                // Déjà identique ici — typiquement notre propre écriture de
                // la synchro précédente qui revient : on note la révision.
                state.items.insert(
                    item.id,
                    ItemState {
                        vault_id: v.id,
                        item_type: item.item_type,
                        hash,
                        revision: item.revision,
                    },
                );
                continue;
            }
            let st = state.items.get(&item.id).cloned();
            let local_modified = local.is_some_and(|l| st.as_ref().is_none_or(|s| s.hash != l.hash));
            if local_modified && let Some(mut s) = st {
                // Les deux côtés ont bougé : le local gagne, en se posant sur
                // la révision du serveur pour que le push passe. En reprise
                // (empreinte vidée), ce n'est pas un conflit : le serveur a
                // une version plus ancienne, la nôtre y retourne.
                let resent = s.hash.is_empty();
                s.revision = item.revision;
                state.items.insert(item.id, s);
                if !resent {
                    report.conflicts.push(format!(
                        "{} modifié des deux côtés : votre version conservée",
                        label_of(&local.expect("local_modified").json)
                    ));
                }
                continue;
            }
            let vault = (v.kind != VaultKind::Personal).then_some(v.id);
            locals.insert(
                item.id,
                LocalEntity {
                    id: item.id,
                    item_type: payload.item_type(),
                    vault_id: v.id,
                    hash: hash.clone(),
                    json,
                },
            );
            changes.push(Change::Upsert {
                payload: Box::new(payload),
                vault,
            });
            state.items.insert(
                item.id,
                ItemState {
                    vault_id: v.id,
                    item_type: item.item_type,
                    hash,
                    revision: item.revision,
                },
            );
            report.pulled += 1;
            *report.pulled_by_vault.entry(v.name.clone()).or_default() += 1;
        }
        state.vault_revisions.insert(v.id, page.revision);
    }

    // ─── Push ────────────────────────────────────────────────────────────
    let mut ids: Vec<Uuid> = locals.keys().copied().collect();
    ids.sort();
    for id in ids {
        let local = &locals[&id];
        let st = state.items.get(&id).cloned();
        if frozen.contains(&local.vault_id) || st.as_ref().is_some_and(|s| frozen.contains(&s.vault_id)) {
            continue;
        }
        let vault = &vaults[&local.vault_id];
        let moved = st.as_ref().is_some_and(|s| s.vault_id != local.vault_id);
        let changed = st.as_ref().is_none_or(|s| s.hash != local.hash);
        if !moved && !changed {
            continue;
        }
        if !vault.role.can_write_items() {
            if changed {
                report.warnings.push(format!(
                    "{} : le vault « {} » est en lecture seule, modification non envoyée",
                    label_of(&local.json),
                    vault.name
                ));
            }
            continue;
        }
        if moved {
            let old = st.as_ref().expect("moved implies state");
            match client.delete_item(old.vault_id, id).await {
                Ok(()) => {}
                Err(e) if matches!(e.code(), Some("not_found") | Some("forbidden")) => {}
                Err(e) => return Err(super::account::user_error(e)),
            }
        }
        let base = if moved { None } else { st.as_ref().map(|s| s.revision) };
        let item = match put(&client, vault, local, base).await {
            Ok(item) => item,
            Err(e) => match conflict_current(&e) {
                Some(current) => {
                    // Quelqu'un a écrit entre-temps : le local gagne. En
                    // reprise après un retour en arrière (empreinte vidée),
                    // c'est le serveur qui a perdu l'item : il est recréé.
                    let base = current.filter(|c| !c.deleted).map(|c| c.revision);
                    if st.as_ref().is_none_or(|s| !s.hash.is_empty()) {
                        report.conflicts.push(format!("{} modifié des deux côtés : votre version conservée", label_of(&local.json)));
                    }
                    match put(&client, vault, local, base).await {
                        Ok(item) => item,
                        Err(e) => {
                            report.warnings.push(format!("{} non envoyé : {e}", label_of(&local.json)));
                            continue;
                        }
                    }
                }
                None => return Err(super::account::user_error(e)),
            },
        };
        state.items.insert(
            id,
            ItemState {
                vault_id: local.vault_id,
                item_type: local.item_type.to_string(),
                hash: local.hash.clone(),
                revision: item.revision,
            },
        );
        report.pushed += 1;
    }

    // ─── Suppressions locales → tombales ─────────────────────────────────
    let gone: Vec<(Uuid, ItemState)> = state
        .items
        .iter()
        .filter(|(id, _)| !locals.contains_key(id))
        .map(|(id, s)| (*id, s.clone()))
        .collect();
    for (id, s) in gone {
        if frozen.contains(&s.vault_id) {
            continue;
        }
        let Some(vault) = vaults.get(&s.vault_id) else {
            state.items.remove(&id);
            continue;
        };
        if !vault.role.can_write_items() {
            // Supprimé ici sans le droit : on oublie l'état et on force le
            // re-téléchargement du vault à la prochaine synchro.
            state.items.remove(&id);
            state.vault_revisions.remove(&s.vault_id);
            report.warnings.push(format!("suppression non permise dans « {} » : l'entité reviendra", vault.name));
            continue;
        }
        match client.delete_item(s.vault_id, id).await {
            Ok(()) => report.deleted_remotely += 1,
            Err(e) if e.code() == Some("not_found") => {}
            Err(e) => return Err(super::account::user_error(e)),
        }
        state.items.remove(&id);
    }

    manager.update_state(|s| {
        s.sync = state;
        s.last_sync_at = Some(chrono::Utc::now());
    })?;
    manager.persist_tokens();
    Ok((changes, report))
}

async fn put(client: &Client, vault: &super::account::VaultInfo, local: &LocalEntity, base: Option<i64>) -> Result<Item, ClientError> {
    let ct = gc::seal_item(&vault.key, &vault.id.to_string(), &local.id.to_string(), local.item_type, local.json.as_bytes())
        .map_err(|e| ClientError::Decode(e.to_string()))?;
    client
        .put_item(
            vault.id,
            local.id,
            &proto::PutItemRequest {
                item_type: local.item_type.to_string(),
                ciphertext: ct,
                base_revision: base,
            },
        )
        .await
}

/// Joue les changements sur le workspace vivant.
pub fn apply_changes(workspace: &mut Workspace, changes: Vec<Change>) {
    for c in changes {
        match c {
            Change::Upsert { payload, vault } => {
                let id = payload.id();
                entity::apply(workspace, *payload);
                match vault {
                    Some(v) => {
                        workspace.vault_bindings.insert(id, v);
                    }
                    None => {
                        workspace.vault_bindings.remove(&id);
                    }
                }
            }
            Change::Remove { item_type, id } => entity::remove(workspace, &item_type, id),
            Change::Rebind { id, vault } => match vault {
                Some(v) => {
                    workspace.vault_bindings.insert(id, v);
                }
                None => {
                    workspace.vault_bindings.remove(&id);
                }
            },
        }
    }
}

/// Re-chiffre tout un vault sous une nouvelle clé (après le retrait d'un
/// membre). Lit les items en face plutôt que le workspace : c'est le contenu
/// du serveur qu'on protège, y compris ce que d'autres y ont mis.
pub async fn rotate_vault_key(manager: &Manager, vault_id: VaultId) -> anyhow::Result<()> {
    let client = manager.client()?;
    let vault = manager.vault_info(vault_id)?;
    // Révision et membres à jour d'abord.
    let remote = client.sync().await.map_err(super::account::user_error)?;
    manager.update_session(|s| s.absorb_vaults(&remote.vaults))?;
    let vault_now = manager.vault_info(vault_id)?;
    let members = client.members(vault_id).await.map_err(super::account::user_error)?;
    let page = client.items(vault_id, None).await.map_err(super::account::user_error)?;

    let new_key = gc::SymmetricKey::random();
    let mut items = Vec::with_capacity(page.items.len());
    for it in &page.items {
        let plain = gc::open_item(&vault.key, &vault_id.to_string(), &it.id.to_string(), &it.item_type, &it.ciphertext)
            .map_err(|e| anyhow::anyhow!("item {} illisible avec la clé actuelle : {e}", it.id))?;
        items.push(proto::RotatedItem {
            id: it.id,
            ciphertext: gc::seal_item(&new_key, &vault_id.to_string(), &it.id.to_string(), &it.item_type, &plain)?,
        });
    }
    let mut wrapped = Vec::with_capacity(members.len());
    for m in &members {
        let pk = gc::PublicKey::try_from(m.public_key.as_slice()).map_err(|_| anyhow::anyhow!("clé publique de {} invalide", m.email))?;
        // Chaque membre restant doit avoir une empreinte vérifiée : sinon le
        // serveur pourrait glisser une clé à lui dans la liste des membres.
        if m.user_id != manager.with_state(|s| s.user_id)? {
            manager.require_pinned(&m.email, &m.fingerprint)?;
        }
        wrapped.push(proto::RotatedMemberKey {
            user_id: m.user_id,
            wrapped_vault_key: gc::wrap_vault_key(&pk, &new_key)?,
        });
    }
    let req = proto::RotateVaultKeyRequest {
        name_enc: gc::seal_vault_name(&new_key, &vault_id.to_string(), &vault_now.name)?,
        members: wrapped,
        items,
        base_revision: vault_now.revision,
    };
    let updated = client.rotate_vault_key(vault_id, &req).await.map_err(super::account::user_error)?;
    manager.update_session(|s| {
        if let Some(v) = s.vaults.get_mut(&vault_id) {
            v.key = new_key.clone();
            v.revision = updated.revision;
        }
        Ok(())
    })?;
    // Les révisions des items ont changé : forcer un re-téléchargement (les
    // empreintes locales restent valides, donc rien ne sera re-poussé).
    manager.update_state(|s| {
        s.sync.vault_revisions.remove(&vault_id);
    })?;
    manager.persist_tokens();
    Ok(())
}
