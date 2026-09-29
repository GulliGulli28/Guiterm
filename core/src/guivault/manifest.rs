//! Le manifeste de vault de GuiVault (`~/GuiVault/docs/MANIFESTE.md`), côté
//! Guiterm. L'AAD d'un item le lie à son vault, son id et son type, pas à sa
//! révision : sans manifeste, un serveur malveillant peut rejouer l'ancien
//! chiffré d'un item, en retenir un, ou en ressusciter un supprimé. Le
//! manifeste — id d'item → SHA-256 du chiffré, et un compteur, scellé sous la
//! clé du vault — dit ce que le vault contient ; chaque écriture le réécrit.
//!
//! Ce que Guiterm en fait :
//! - **vérifier au pull.** Guiterm lit des deltas (`?since=`) ; la
//!   vérification demande l'état complet. [`VaultIntegrity::items`] le tient :
//!   l'empreinte de chaque item vivant du vault — secrets de l'interface web
//!   compris, que la synchro ignore par ailleurs —, mise à jour delta après
//!   delta et par nos propres écritures (une tombale reste en base côté
//!   serveur : un delta dit toujours ce qui est parti). Un écart suspend la
//!   synchronisation du vault (`sync::run`), comme un retour en arrière ;
//! - **l'entretenir à chaque écriture** ([`put_item`], [`delete_item`]) : le
//!   dernier manifeste connu, plus le changement, compteur + 1, dans la même
//!   requête. Sur `409 manifest_conflict`, on repart du manifeste courant
//!   joint — il vient d'un membre, le serveur ne sait pas le fabriquer : on
//!   vérifie seulement qu'il s'ouvre et ne recule pas ; sur `409
//!   manifest_required` (le vault vient d'en recevoir un), on le lit.
//!
//! Un vault sans manifeste n'en reçoit pas d'ici : c'est l'interface web qui
//! les active. Guiterm ne fait qu'entretenir ceux qui existent.
use super::account::VaultInfo;
use super::client::{Client, ClientError};
use guivault_crypto as gc;
use guivault_protocol::{self as proto, Item, ManifestWrite, VaultManifest};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Par vault, dans `SyncState::integrity`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultIntegrity {
    /// L'empreinte (`gc::item_digest`) de chaque item vivant du vault, à la
    /// dernière révision lue — l'état complet, reconstitué des deltas.
    #[serde(default)]
    pub items: BTreeMap<Uuid, String>,
    /// Le dernier manifeste lu ou écrit d'ici (son compteur est sa révision
    /// côté serveur) : la base de la prochaine écriture. `None` : le vault
    /// n'en a pas.
    #[serde(default)]
    pub manifest: Option<gc::Manifest>,
    /// Le plus grand compteur vu d'ici : un manifeste plus ancien, ou plus de
    /// manifeste du tout, se voit ainsi.
    #[serde(default)]
    pub seen: Option<i64>,
}

impl VaultIntegrity {
    /// Un delta (`?since=`), ou une lecture complète (`full`) qui remplace
    /// tout ce qu'on savait.
    pub fn absorb(&mut self, items: &[Item], full: bool) {
        if full {
            self.items.clear();
        }
        for it in items {
            if it.deleted {
                self.items.remove(&it.id);
            } else {
                self.items.insert(it.id, gc::item_digest(&it.ciphertext));
            }
        }
    }

    /// Ce que sert le serveur (le manifeste de la page, et l'état tenu par
    /// [`absorb`](Self::absorb)) contre ce qu'on a déjà vu.
    pub fn verify(&self, vault: &VaultInfo, served: Option<&VaultManifest>) -> gc::Verified {
        let ids: Vec<(String, &str)> = self.items.iter().map(|(id, d)| (id.to_string(), d.as_str())).collect();
        gc::verify_manifest_digests(
            &vault.key,
            &vault.id.to_string(),
            served.map(|m| (m.revision, m.ciphertext.as_slice())),
            ids.iter().map(|(id, d)| (id.as_str(), *d)),
            self.seen,
        )
    }

    /// Après une vérification sans écart : le manifeste devient la base des
    /// écritures, son compteur est retenu.
    pub fn accept(&mut self, verified: gc::Verified) {
        self.manifest = verified.manifest;
        if let Some(m) = &self.manifest {
            self.observe(m.counter);
        }
    }

    fn observe(&mut self, counter: i64) {
        if self.seen.is_none_or(|s| s < counter) {
            self.seen = Some(counter);
        }
    }

    /// Un manifeste reçu hors d'une lecture complète (conflit, `GET
    /// /manifest`) : il doit s'ouvrir, porter la révision annoncée et ne pas
    /// reculer. Plus de manifeste du tout alors qu'on en a vu un : refusé.
    pub fn adopt(&mut self, vault: &VaultInfo, served: Option<VaultManifest>) -> Result<(), ClientError> {
        let refuse = |why: String| ClientError::Decode(format!("manifeste du vault « {} » : {why}", vault.name));
        let Some(served) = served else {
            if let Some(seen) = self.seen.filter(|s| *s > 0) {
                return Err(refuse(format!("le serveur n'en sert plus (vu ici jusqu'à la version {seen})")));
            }
            self.manifest = None;
            return Ok(());
        };
        let m = gc::open_manifest(&vault.key, &vault.id.to_string(), &served.ciphertext)
            .map_err(|_| refuse("il ne s'ouvre pas avec la clé du vault".into()))?;
        if m.counter != served.revision {
            return Err(refuse(format!("sa version ({}) n'est pas celle annoncée ({})", m.counter, served.revision)));
        }
        if let Some(seen) = self.seen.filter(|s| *s > m.counter) {
            return Err(refuse(format!("il est revenu à la version {}, alors que la {seen} a déjà été vue ici", m.counter)));
        }
        self.observe(m.counter);
        self.manifest = Some(m);
        Ok(())
    }

    /// Le manifeste suivant avec `change`, scellé, et ce qu'il deviendra une
    /// fois accepté. `None` : le vault n'a pas de manifeste, rien à envoyer.
    fn next(&self, vault: &VaultInfo, change: impl FnOnce(&mut gc::Manifest)) -> Result<Option<(ManifestWrite, gc::Manifest)>, ClientError> {
        let Some(base) = &self.manifest else { return Ok(None) };
        let mut next = base.next(base.counter);
        change(&mut next);
        let ciphertext = gc::seal_manifest(&vault.key, &vault.id.to_string(), &next).map_err(|e| ClientError::Decode(format!("chiffrement du manifeste : {e}")))?;
        Ok(Some((ManifestWrite { ciphertext, base_revision: base.counter }, next)))
    }

    /// Après une écriture acceptée.
    fn wrote(&mut self, id: Uuid, digest: Option<String>, next: Option<gc::Manifest>) {
        match digest {
            Some(d) => self.items.insert(id, d),
            None => self.items.remove(&id),
        };
        if let Some(m) = next {
            self.observe(m.counter);
            self.manifest = Some(m);
        }
    }

    /// Le manifeste d'après l'état servi, qui devient la référence (reprise
    /// après un écart) : réécrit par qui peut écrire, sinon seulement accepté
    /// d'ici. `page_revision` : la révision du vault lue avec cet état.
    pub async fn rewrite(&mut self, client: &Client, vault: &VaultInfo, served: Option<&VaultManifest>, page_revision: i64) -> Result<(), ClientError> {
        let Some(served) = served else {
            // Plus de manifeste : rien à réécrire (l'activer est l'affaire de
            // l'interface web), on oublie ce qu'on en avait vu.
            self.manifest = None;
            self.seen = None;
            return Ok(());
        };
        if !vault.role.can_write_items() {
            self.manifest = gc::open_manifest(&vault.key, &vault.id.to_string(), &served.ciphertext).ok().filter(|m| m.counter == served.revision);
            self.seen = Some(served.revision);
            return Ok(());
        }
        let m = gc::Manifest {
            v: gc::manifest::MANIFEST_VERSION,
            counter: served.revision + 1,
            items: self.items.iter().map(|(id, d)| (id.to_string(), d.clone())).collect(),
        };
        let ciphertext = gc::seal_manifest(&vault.key, &vault.id.to_string(), &m).map_err(|e| ClientError::Decode(format!("chiffrement du manifeste : {e}")))?;
        let written = client
            .put_manifest(vault.id, &proto::PutManifestRequest { ciphertext, base_revision: served.revision, vault_revision: page_revision })
            .await?;
        self.seen = Some(written.revision);
        self.manifest = Some(m);
        Ok(())
    }
}

/// Le manifeste joint à un `409 manifest_conflict` (`current`, `null` si le
/// vault n'en a plus).
fn conflict_current(e: &ClientError) -> Option<Option<VaultManifest>> {
    match e {
        ClientError::Api { code, body, .. } if code == "manifest_conflict" => Some(serde_json::from_value(body["current"].clone()).ok().flatten()),
        _ => None,
    }
}

/// Écrit un item (chiffré par l'appelant) avec le manifeste qui l'accompagne.
/// Les autres refus (`revision_mismatch`…) remontent tels quels.
pub async fn put_item(
    client: &Client,
    vault: &VaultInfo,
    integrity: &mut VaultIntegrity,
    id: Uuid,
    item_type: &str,
    ciphertext: Vec<u8>,
    base_revision: Option<i64>,
) -> Result<Item, ClientError> {
    let digest = gc::item_digest(&ciphertext);
    let mut attempt = 0;
    loop {
        let next = integrity.next(vault, |m| m.put(&id.to_string(), &ciphertext))?;
        let req = proto::PutItemRequest { item_type: item_type.to_string(), ciphertext: ciphertext.clone(), base_revision, manifest: next.as_ref().map(|(w, _)| w.clone()) };
        match client.put_item(vault.id, id, &req).await {
            Ok(item) => {
                integrity.wrote(id, Some(digest), next.map(|(_, m)| m));
                return Ok(item);
            }
            Err(e) => {
                attempt += 1;
                retry(client, vault, integrity, e, attempt).await?;
            }
        }
    }
}

/// Supprime un item (`moved` : il part vers un autre vault) avec le
/// manifeste qui l'accompagne.
pub async fn delete_item(client: &Client, vault: &VaultInfo, integrity: &mut VaultIntegrity, id: Uuid, moved: bool) -> Result<(), ClientError> {
    let mut attempt = 0;
    loop {
        let next = integrity.next(vault, |m| m.remove(&id.to_string()))?;
        match client.delete_item(vault.id, id, moved, next.as_ref().map(|(w, _)| w.clone())).await {
            Ok(()) => {
                integrity.wrote(id, None, next.map(|(_, m)| m));
                return Ok(());
            }
            Err(e) => {
                attempt += 1;
                retry(client, vault, integrity, e, attempt).await?;
            }
        }
    }
}

/// Un refus d'écriture : on repart du manifeste courant et on recommence
/// (trois fois au plus), ou l'erreur remonte.
async fn retry(client: &Client, vault: &VaultInfo, integrity: &mut VaultIntegrity, e: ClientError, attempt: u32) -> Result<(), ClientError> {
    if attempt >= 3 {
        return Err(e);
    }
    if let Some(current) = conflict_current(&e) {
        return integrity.adopt(vault, current);
    }
    if e.code() == Some("manifest_required") {
        let current = client.manifest(vault.id).await?;
        return integrity.adopt(vault, current);
    }
    Err(e)
}

/// Le texte d'un écart, avec le nom de l'entité quand on le connaît — les
/// mots de l'interface web de GuiVault (`problemText`).
pub fn problem_text(p: &gc::ManifestProblem, name_of: impl Fn(&str) -> Option<String>) -> String {
    let item = |id: &str| name_of(id).unwrap_or_else(|| format!("l'élément {id}"));
    match p {
        gc::ManifestProblem::Unexpected { item_id } => {
            format!("{} n'est pas dans le manifeste (ajouté hors des clients, ou revenu après suppression)", item(item_id))
        }
        gc::ManifestProblem::Altered { item_id } => {
            format!("{} n'est pas la version annoncée par le manifeste (une ancienne version rejouée ?)", item(item_id))
        }
        gc::ManifestProblem::Withheld { item_id } => format!("{} est dans le manifeste mais le serveur ne le sert pas", item(item_id)),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::VaultId;
    use guivault_protocol::{Role, VaultKind};

    fn vault() -> VaultInfo {
        VaultInfo {
            id: VaultId::new_v4(),
            name: "Équipe".into(),
            kind: VaultKind::Shared,
            role: Role::Writer,
            revision: 0,
            key: gc::SymmetricKey::random(),
            key_from: super::super::account::KeyFrom::Own,
        }
    }

    fn item(v: &VaultInfo, id: Uuid, revision: i64, body: &str) -> Item {
        Item {
            id,
            vault_id: v.id,
            item_type: "host".into(),
            revision,
            ciphertext: gc::seal_item(&v.key, &v.id.to_string(), &id.to_string(), "host", body.as_bytes()).unwrap(),
            deleted: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn served(v: &VaultInfo, counter: i64, items: &[&Item]) -> VaultManifest {
        let m = gc::Manifest::of(counter, items.iter().map(|i| (i.id.to_string(), i.ciphertext.clone())).collect::<Vec<_>>().iter().map(|(id, c)| (id.as_str(), c.as_slice())));
        VaultManifest { ciphertext: gc::seal_manifest(&v.key, &v.id.to_string(), &m).unwrap(), revision: counter }
    }

    #[test]
    fn deltas_rebuild_the_full_state_that_the_manifest_checks() {
        let v = vault();
        let (a, b) = (item(&v, Uuid::new_v4(), 1, "a"), item(&v, Uuid::new_v4(), 2, "b"));
        let mut integ = VaultIntegrity::default();
        integ.absorb(&[a.clone(), b.clone()], true);
        let verified = integ.verify(&v, Some(&served(&v, 2, &[&a, &b])));
        assert!(verified.problems.is_empty(), "{:?}", verified.problems);
        integ.accept(verified);
        assert_eq!(integ.seen, Some(2));

        // Delta : b supprimé, a modifié — et le manifeste qui va avec.
        let a2 = item(&v, a.id, 3, "a2");
        let tomb = Item { deleted: true, ciphertext: vec![], revision: 4, ..b.clone() };
        integ.absorb(&[a2.clone(), tomb], false);
        assert!(integ.verify(&v, Some(&served(&v, 4, &[&a2]))).problems.is_empty());

        // Le serveur rejoue l'ancienne version de a, et ressert un vieux manifeste.
        integ.absorb(&[Item { revision: 5, ..a.clone() }], false);
        assert_eq!(integ.verify(&v, Some(&served(&v, 4, &[&a2]))).problems, vec![gc::ManifestProblem::Altered { item_id: a.id.to_string() }]);
        integ.accept(integ.verify(&v, Some(&served(&v, 4, &[&a2]))));
        let old = integ.verify(&v, Some(&served(&v, 1, &[&a])));
        assert!(old.problems.contains(&gc::ManifestProblem::Rollback { counter: 1, seen: 4 }), "{:?}", old.problems);
    }

    #[test]
    fn a_manifest_from_a_conflict_must_open_and_not_go_back() {
        let v = vault();
        let a = item(&v, Uuid::new_v4(), 1, "a");
        let mut integ = VaultIntegrity { seen: Some(3), ..Default::default() };
        assert!(integ.adopt(&v, Some(served(&v, 2, &[&a]))).is_err(), "recul");
        assert!(integ.adopt(&v, None).is_err(), "disparu");
        let forged = VaultManifest { ciphertext: a.ciphertext.clone(), revision: 5 };
        assert!(integ.adopt(&v, Some(forged)).is_err(), "un chiffré d'item n'est pas un manifeste");
        let mut shifted = served(&v, 5, &[&a]);
        shifted.revision = 6;
        assert!(integ.adopt(&v, Some(shifted)).is_err(), "compteur ≠ révision");
        integ.adopt(&v, Some(served(&v, 5, &[&a]))).unwrap();
        assert_eq!((integ.seen, integ.manifest.as_ref().map(|m| m.counter)), (Some(5), Some(5)));

        // L'écriture suivante s'appuie dessus : compteur 6, base 5.
        let (write, next) = integ.next(&v, |m| m.remove(&a.id.to_string())).unwrap().unwrap();
        assert_eq!((write.base_revision, next.counter), (5, 6));
        assert!(next.items.is_empty());
        // Sans manifeste, rien à joindre.
        assert!(VaultIntegrity::default().next(&v, |_| {}).unwrap().is_none());
    }
}
