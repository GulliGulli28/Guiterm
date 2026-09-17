//! Déplacer des entités entre deux workspaces (le profil local et celui du
//! compte), ou entre vaults d'un même compte — depuis le menu des vaults,
//! à tout moment, pas seulement à la première connexion.
//!
//! Une entité ne part jamais seule : un hôte emmène sa chaîne de dossiers
//! et sa clé du trousseau, un dossier emmène son sous-arbre (dossiers et
//! hôtes). Sans ça, l'arrivée serait un hôte rangé « nulle part » ou une
//! clé qui manque. Les secrets ne bougent pas : ils sont dans le coffre
//! local, indexés par l'id de l'entité, qui ne change pas.
use super::entity;
use crate::model::{VaultId, Workspace};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

/// Une entité telle que le panneau la liste.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySummary {
    pub id: Uuid,
    /// `host` | `group` | `snippet` | `key` | `sql-connection`.
    pub kind: &'static str,
    pub name: String,
    /// Chemin de dossiers (« Prod / Bases »), pour situer un hôte.
    pub path: String,
    /// Le dossier qui contient l'entité (hôte, connexion, sous-dossier) —
    /// c'est ce qui permet au panneau de reconstruire l'arborescence. `None`
    /// à la racine, et toujours pour une clé ou un snippet.
    pub parent_id: Option<Uuid>,
    /// Vault partagé d'affiliation, `None` = personnel (ou local).
    pub vault_id: Option<VaultId>,
}

/// D'où vient, ou où va, une sélection : le profil local de l'appareil, ou
/// le compte connecté — dans son vault personnel (`vault_id: None`) ou un
/// vault partagé. Le JSON est à tag interne : `{"kind":"local"}` ou
/// `{"kind":"account","vaultId":"…"|null}` (testé, voir `place_json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Place {
    Local,
    Account { vault_id: Option<VaultId> },
}

impl Place {
    /// Le vault partagé concerné, s'il y en a un.
    pub fn shared_vault(self) -> Option<VaultId> {
        match self {
            Place::Account { vault_id } => vault_id,
            Place::Local => None,
        }
    }
}

fn group_path(ws: &Workspace, mut group_id: Option<Uuid>) -> String {
    let mut parts = Vec::new();
    let mut seen = BTreeSet::new();
    while let Some(id) = group_id {
        if !seen.insert(id) {
            break;
        }
        match ws.groups.iter().find(|g| g.id == id) {
            Some(g) => {
                parts.push(g.name.clone());
                group_id = g.parent_id;
            }
            None => break,
        }
    }
    parts.reverse();
    parts.join(" / ")
}

pub fn list(ws: &Workspace) -> Vec<EntitySummary> {
    let vault_of = |id: Uuid| ws.vault_bindings.get(&id).copied();
    let mut out = Vec::new();
    for g in &ws.groups {
        out.push(EntitySummary { id: g.id, kind: "group", name: g.name.clone(), path: group_path(ws, g.parent_id), parent_id: g.parent_id, vault_id: vault_of(g.id) });
    }
    for h in &ws.hosts {
        out.push(EntitySummary { id: h.id, kind: "host", name: h.label.clone(), path: group_path(ws, h.group_id), parent_id: h.group_id, vault_id: vault_of(h.id) });
    }
    for k in &ws.keychain {
        out.push(EntitySummary { id: k.id, kind: "key", name: k.name.clone(), path: String::new(), parent_id: None, vault_id: vault_of(k.id) });
    }
    for s in &ws.snippets {
        out.push(EntitySummary { id: s.id, kind: "snippet", name: s.name.clone(), path: String::new(), parent_id: None, vault_id: vault_of(s.id) });
    }
    for c in &ws.sql_connections {
        out.push(EntitySummary { id: c.id, kind: "sql-connection", name: c.label.clone(), path: group_path(ws, c.group_id), parent_id: c.group_id, vault_id: vault_of(c.id) });
    }
    out
}

/// Ferme une sélection : ce qui doit accompagner chaque entité choisie.
pub fn closure(ws: &Workspace, ids: &[Uuid]) -> BTreeSet<Uuid> {
    let mut set: BTreeSet<Uuid> = ids.iter().copied().collect();
    let mut queue: Vec<Uuid> = ids.to_vec();
    while let Some(id) = queue.pop() {
        if let Some(h) = ws.host(id) {
            let mut g = h.group_id;
            while let Some(gid) = g {
                if !set.insert(gid) {
                    break;
                }
                g = ws.groups.iter().find(|x| x.id == gid).and_then(|x| x.parent_id);
            }
            if let crate::model::AuthMethod::PrivateKey { key_id: Some(k), .. } = &h.auth {
                set.insert(*k);
            }
        } else if ws.groups.iter().any(|g| g.id == id) {
            // Sous-arbre : dossiers enfants et hôtes/connexions rangés dedans.
            for child in ws.groups.iter().filter(|g| g.parent_id == Some(id)) {
                if set.insert(child.id) {
                    queue.push(child.id);
                }
            }
            for h in ws.hosts.iter().filter(|h| h.group_id == Some(id)) {
                if set.insert(h.id) {
                    queue.push(h.id);
                }
            }
            for c in ws.sql_connections.iter().filter(|c| c.group_id == Some(id)) {
                set.insert(c.id);
            }
            // Et la chaîne des parents, pour que le dossier arrive à sa place.
            let mut g = ws.groups.iter().find(|x| x.id == id).and_then(|x| x.parent_id);
            while let Some(gid) = g {
                if !set.insert(gid) {
                    break;
                }
                g = ws.groups.iter().find(|x| x.id == gid).and_then(|x| x.parent_id);
            }
        }
    }
    set
}

/// Déplace `ids` (fermés par [`closure`]) de `from` vers `to`. Dans `to`,
/// l'affiliation est `vault` (un vault partagé) ou aucune (personnel /
/// local). Rend le nombre d'entités déplacées.
pub fn transfer(from: &mut Workspace, to: &mut Workspace, ids: &[Uuid], vault: Option<VaultId>) -> usize {
    let set = closure(from, ids);
    let mut moved = 0;
    macro_rules! move_list {
        ($field:ident, $id:ident) => {{
            let (take, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut from.$field).into_iter().partition(|e| set.contains(&e.$id));
            from.$field = keep;
            for e in take {
                to.$field.retain(|x| x.$id != e.$id);
                to.$field.push(e);
                moved += 1;
            }
        }};
    }
    move_list!(groups, id);
    move_list!(hosts, id);
    move_list!(keychain, id);
    move_list!(snippets, id);
    move_list!(sql_connections, id);
    for id in &set {
        from.vault_bindings.remove(id);
        match vault {
            Some(v) => {
                to.vault_bindings.insert(*id, v);
            }
            None => {
                to.vault_bindings.remove(id);
            }
        }
    }
    moved
}

/// Copie `ids` (fermés) de `from` dans `to`, sous de **nouveaux ids** : les
/// deux exemplaires vivent ensuite leur vie — l'un peut être supprimé, ou
/// recevoir une tombale du serveur, sans emporter les secrets de l'autre
/// (le coffre local les indexe par id). Les références entre entités
/// copiées (dossier d'un hôte, clé, bastions…) sont réécrites vers les
/// nouveaux ids ; une référence vers une entité non copiée est laissée
/// telle quelle. Les secrets sont dupliqués via les charges utiles de
/// [`entity`], qui les lisent et les réécrivent dans le coffre local.
pub fn copy_between(from: &Workspace, to: &mut Workspace, ids: &[Uuid], vault: Option<VaultId>) -> anyhow::Result<usize> {
    let set = closure(from, ids);
    // `collect` veut un vault « personnel » pour les entités sans
    // affiliation : sans importance ici, seul le JSON compte.
    let payloads: Vec<String> = entity::collect(from, Uuid::nil())?
        .into_iter()
        .filter(|e| set.contains(&e.id))
        .map(|e| e.json)
        .collect();
    let mapping: Vec<(String, String)> = set.iter().map(|id| (id.to_string(), Uuid::new_v4().to_string())).collect();
    let mut copied = 0;
    for json in payloads {
        // Réécriture textuelle : un uuid v4 est une chaîne unique, elle ne
        // peut apparaître qu'en tant que référence à cette entité.
        let mut text = json;
        for (old, new) in &mapping {
            text = text.replace(old, new);
        }
        let payload = entity::Payload::from_json(text.as_bytes())?;
        let new_id = payload.id();
        entity::apply(to, payload);
        match vault {
            Some(v) => {
                to.vault_bindings.insert(new_id, v);
            }
            None => {
                to.vault_bindings.remove(&new_id);
            }
        }
        copied += 1;
    }
    Ok(copied)
}

/// Change l'affiliation de `ids` (fermés) dans le workspace du compte :
/// vers un vault partagé, ou vers le personnel (`None`). Un hôte emmène ce
/// qu'il référence et qui n'est pas déjà partagé — clé, chaîne de dossiers —
/// sinon les autres membres verraient un hôte qui pointe vers une clé qu'ils
/// n'ont pas, ou rangé dans un dossier qui n'existe pas chez eux. Vers le
/// personnel, le sous-arbre suit aussi : un dossier ne reste pas partagé avec
/// un hôte personnel dedans. Rend le nombre d'entités concernées.
pub fn move_within(ws: &mut Workspace, ids: &[Uuid], vault: Option<VaultId>) -> usize {
    let set = closure(ws, ids);
    for id in &set {
        match vault {
            Some(v) => {
                if ids.contains(id) {
                    ws.vault_bindings.insert(*id, v);
                } else {
                    ws.vault_bindings.entry(*id).or_insert(v);
                }
            }
            None => {
                ws.vault_bindings.remove(id);
            }
        }
    }
    set.len()
}

/// Les vaults partagés d'où `ids` (fermés) sortiraient, dans `ws`.
fn source_vaults(ws: &Workspace, ids: &[Uuid]) -> BTreeSet<VaultId> {
    closure(ws, ids).iter().filter_map(|id| ws.vault_bindings.get(id).copied()).collect()
}

/// **Le seul point d'entrée** pour déplacer ou copier une sélection entre
/// deux emplacements ([`Place`]) — le panneau ne connaît que celui-ci, quel
/// que soit le sens. `local` et `account` sont les deux workspaces du compte
/// connecté (l'appelant sait lequel est en mémoire et lequel sur le disque ;
/// ici on ne fait que les modifier). `can_write(vault)` dit si le compte
/// écrit dans ce vault partagé : requis à l'**arrivée** dans un vault, et au
/// **départ** d'un vault quand on déplace (retirer une entité d'un vault en
/// lecture seule la ferait juste revenir à la synchro suivante). Une copie
/// ne retire rien, donc ne demande rien au départ. Rend le nombre d'entités
/// déplacées ou copiées.
pub fn apply(
    local: &mut Workspace,
    account: &mut Workspace,
    ids: &[Uuid],
    from: Place,
    to: Place,
    copy: bool,
    can_write: impl Fn(VaultId) -> bool,
) -> anyhow::Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    if let Some(v) = to.shared_vault()
        && !can_write(v)
    {
        anyhow::bail!("pas de droit d'écriture dans le vault de destination");
    }
    if !copy
        && matches!(from, Place::Account { .. })
        && source_vaults(account, ids).into_iter().any(|v| !can_write(v))
    {
        anyhow::bail!("une des entités vient d'un vault en lecture seule : impossible de l'en retirer");
    }
    match (from, to) {
        (Place::Local, Place::Local) => anyhow::bail!("l'origine et la destination sont toutes deux le profil local"),
        (Place::Local, Place::Account { vault_id }) => {
            if copy {
                copy_between(local, account, ids, vault_id)
            } else {
                Ok(transfer(local, account, ids, vault_id))
            }
        }
        (Place::Account { .. }, Place::Local) => {
            if copy {
                copy_between(account, local, ids, None)
            } else {
                Ok(transfer(account, local, ids, None))
            }
        }
        (Place::Account { vault_id: src }, Place::Account { vault_id }) => {
            if src == vault_id {
                anyhow::bail!("l'origine et la destination sont le même vault");
            }
            if copy {
                // Copier dans le même workspace : la source est figée le temps
                // de la copie (les nouveaux ids n'entrent pas en collision).
                let snapshot = account.clone();
                copy_between(&snapshot, account, ids, vault_id)
            } else {
                Ok(move_within(account, ids, vault_id))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Group, Host};

    #[test]
    fn copy_gives_new_ids_and_rewrites_references() {
        let mut ws = Workspace::default();
        let g = Group { id: Uuid::new_v4(), name: "Prod".into(), parent_id: None, icon: None, color: None };
        let mut bastion = Host::new("bastion", "10.0.0.1", "root");
        bastion.group_id = Some(g.id);
        let mut h = Host::new("db1", "10.0.0.2", "root");
        h.group_id = Some(g.id);
        h.jump_via = vec![bastion.id];
        ws.groups.push(g.clone());
        ws.hosts.extend([bastion.clone(), h.clone()]);

        let mut to = Workspace::default();
        // Copier db1 seul : son dossier suit, son bastion (référencé mais
        // hors fermeture) ne suit pas et garde son id d'origine.
        assert_eq!(copy_between(&ws, &mut to, &[h.id], None).unwrap(), 2);
        assert_eq!(ws.hosts.len(), 2, "l'original reste");
        let copied = to.hosts.iter().find(|x| x.label == "db1").unwrap();
        assert_ne!(copied.id, h.id);
        let copied_group = to.groups.iter().find(|x| x.name == "Prod").unwrap();
        assert_ne!(copied_group.id, g.id);
        assert_eq!(copied.group_id, Some(copied_group.id), "référence réécrite");
        assert_eq!(copied.jump_via, vec![bastion.id], "référence hors copie inchangée");
    }

    #[test]
    fn host_takes_its_folder_chain_and_group_takes_its_subtree() {
        let mut ws = Workspace::default();
        let root = Group { id: Uuid::new_v4(), name: "Prod".into(), parent_id: None, icon: None, color: None };
        let sub = Group { id: Uuid::new_v4(), name: "DB".into(), parent_id: Some(root.id), icon: None, color: None };
        let mut h = Host::new("db1", "10.0.0.1", "root");
        h.group_id = Some(sub.id);
        let lone = Host::new("lone", "10.0.0.2", "root");
        ws.groups.extend([root.clone(), sub.clone()]);
        ws.hosts.extend([h.clone(), lone.clone()]);

        let c = closure(&ws, &[h.id]);
        assert_eq!(c, [h.id, sub.id, root.id].into_iter().collect());
        let c = closure(&ws, &[root.id]);
        assert_eq!(c, [root.id, sub.id, h.id].into_iter().collect());

        let mut to = Workspace::default();
        let v = Uuid::new_v4();
        assert_eq!(transfer(&mut ws, &mut to, &[h.id], Some(v)), 3);
        assert_eq!(ws.hosts.len(), 1);
        assert_eq!(ws.hosts[0].id, lone.id);
        assert!(ws.groups.is_empty());
        assert_eq!(to.hosts.len(), 1);
        assert_eq!(to.groups.len(), 2);
        assert_eq!(to.vault_bindings.get(&h.id), Some(&v));
        assert_eq!(to.vault_bindings.get(&root.id), Some(&v));
        assert_eq!(list(&to).iter().find(|e| e.id == h.id).unwrap().path, "Prod / DB");
    }

    // ── `apply`, un scénario par sens ─────────────────────────────────────
    //
    // Deux vaults partagés : « infra » où le compte écrit, « lecture » où il
    // ne fait que lire. Un hôte personnel dans un dossier, un hôte en lecture
    // seule, un hôte local.
    struct Fixture {
        local: Workspace,
        account: Workspace,
        infra: VaultId,
        lecture: VaultId,
        /// Hôte personnel du compte, dans le dossier `folder`.
        host: Uuid,
        folder: Uuid,
        /// Hôte du vault « lecture ».
        read_only_host: Uuid,
        /// Hôte du profil local.
        local_host: Uuid,
    }

    fn fixture() -> Fixture {
        let infra = Uuid::new_v4();
        let lecture = Uuid::new_v4();
        let mut account = Workspace::default();
        let folder = Group { id: Uuid::new_v4(), name: "Prod".into(), parent_id: None, icon: None, color: None };
        let mut host = Host::new("db1", "10.0.0.1", "root");
        host.group_id = Some(folder.id);
        let ro = Host::new("banque", "10.9.9.9", "audit");
        account.vault_bindings.insert(ro.id, lecture);
        account.groups.push(folder.clone());
        account.hosts.extend([host.clone(), ro.clone()]);
        let mut local = Workspace::default();
        let local_host = Host::new("nas", "192.168.1.2", "pi");
        local.hosts.push(local_host.clone());
        Fixture { local, account, infra, lecture, host: host.id, folder: folder.id, read_only_host: ro.id, local_host: local_host.id }
    }

    fn can_write(infra: VaultId) -> impl Fn(VaultId) -> bool {
        move |v| v == infra
    }

    #[test]
    fn place_json_is_internally_tagged_camel_case() {
        // Le piège serde documenté dans CLAUDE.md : `rename_all` seul ne
        // renomme pas les champs des variantes struct. Un JSON écrit à la
        // main, pas un aller-retour Rust→Rust.
        let v = Uuid::new_v4();
        let account: Place = serde_json::from_str(&format!(r#"{{"kind":"account","vaultId":"{v}"}}"#)).unwrap();
        assert_eq!(account, Place::Account { vault_id: Some(v) });
        let personal: Place = serde_json::from_str(r#"{"kind":"account","vaultId":null}"#).unwrap();
        assert_eq!(personal, Place::Account { vault_id: None });
        let local: Place = serde_json::from_str(r#"{"kind":"local"}"#).unwrap();
        assert_eq!(local, Place::Local);
        assert_eq!(serde_json::to_string(&account).unwrap(), format!(r#"{{"kind":"account","vaultId":"{v}"}}"#));
    }

    #[test]
    fn local_to_shared_vault_moves_and_binds() {
        let mut f = fixture();
        let n = apply(&mut f.local, &mut f.account, &[f.local_host], Place::Local, Place::Account { vault_id: Some(f.infra) }, false, can_write(f.infra)).unwrap();
        assert_eq!(n, 1);
        assert!(f.local.hosts.is_empty(), "déplacé, pas copié");
        assert_eq!(f.account.vault_bindings.get(&f.local_host), Some(&f.infra));
    }

    #[test]
    fn local_to_read_only_vault_is_refused() {
        let mut f = fixture();
        let err = apply(&mut f.local, &mut f.account, &[f.local_host], Place::Local, Place::Account { vault_id: Some(f.lecture) }, false, can_write(f.infra)).unwrap_err();
        assert!(err.to_string().contains("destination"), "{err}");
        assert_eq!(f.local.hosts.len(), 1, "rien n'a bougé");
    }

    #[test]
    fn personal_to_shared_takes_the_folder_along() {
        let mut f = fixture();
        let n = apply(&mut f.local, &mut f.account, &[f.host], Place::Account { vault_id: None }, Place::Account { vault_id: Some(f.infra) }, false, can_write(f.infra)).unwrap();
        assert_eq!(n, 2, "l'hôte et son dossier");
        assert_eq!(f.account.vault_bindings.get(&f.host), Some(&f.infra));
        assert_eq!(f.account.vault_bindings.get(&f.folder), Some(&f.infra));
        assert_eq!(f.account.hosts.len(), 2, "toujours dans le compte");
    }

    #[test]
    fn shared_to_personal_unbinds_the_subtree() {
        let mut f = fixture();
        f.account.vault_bindings.insert(f.host, f.infra);
        f.account.vault_bindings.insert(f.folder, f.infra);
        apply(&mut f.local, &mut f.account, &[f.folder], Place::Account { vault_id: Some(f.infra) }, Place::Account { vault_id: None }, false, can_write(f.infra)).unwrap();
        assert!(!f.account.vault_bindings.contains_key(&f.folder));
        assert!(!f.account.vault_bindings.contains_key(&f.host), "l'hôte du dossier suit");
    }

    #[test]
    fn same_vault_is_refused() {
        let mut f = fixture();
        let err = apply(&mut f.local, &mut f.account, &[f.host], Place::Account { vault_id: None }, Place::Account { vault_id: None }, false, can_write(f.infra)).unwrap_err();
        assert!(err.to_string().contains("même vault"), "{err}");
    }

    #[test]
    fn moving_out_of_read_only_vault_is_refused_but_copying_is_allowed() {
        let mut f = fixture();
        let err = apply(&mut f.local, &mut f.account, &[f.read_only_host], Place::Account { vault_id: Some(f.lecture) }, Place::Local, false, can_write(f.infra)).unwrap_err();
        assert!(err.to_string().contains("lecture seule"), "{err}");
        assert_eq!(f.account.hosts.len(), 2);

        let n = apply(&mut f.local, &mut f.account, &[f.read_only_host], Place::Account { vault_id: Some(f.lecture) }, Place::Local, true, can_write(f.infra)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(f.account.hosts.len(), 2, "la copie ne retire rien");
        let copied = f.local.hosts.iter().find(|h| h.label == "banque").expect("copié en local");
        assert_ne!(copied.id, f.read_only_host, "nouvel id");
        assert!(f.local.vault_bindings.is_empty(), "le local n'a pas d'affiliation");
    }

    #[test]
    fn copy_between_two_vaults_of_the_account_duplicates_under_new_ids() {
        let mut f = fixture();
        let n = apply(&mut f.local, &mut f.account, &[f.host], Place::Account { vault_id: None }, Place::Account { vault_id: Some(f.infra) }, true, can_write(f.infra)).unwrap();
        assert_eq!(n, 2, "l'hôte et son dossier, copiés");
        assert_eq!(f.account.hosts.len(), 3);
        assert_eq!(f.account.groups.len(), 2);
        assert!(!f.account.vault_bindings.contains_key(&f.host), "l'original reste personnel");
        let copies: Vec<_> = f.account.hosts.iter().filter(|h| h.label == "db1" && h.id != f.host).collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(f.account.vault_bindings.get(&copies[0].id), Some(&f.infra));
        let copied_folder = f.account.groups.iter().find(|g| g.id != f.folder).unwrap();
        assert_eq!(copies[0].group_id, Some(copied_folder.id), "référence réécrite vers la copie du dossier");
    }

    #[test]
    fn account_to_local_moves_the_host_with_its_folder() {
        let mut f = fixture();
        let n = apply(&mut f.local, &mut f.account, &[f.host], Place::Account { vault_id: None }, Place::Local, false, can_write(f.infra)).unwrap();
        assert_eq!(n, 2);
        assert_eq!(f.local.hosts.len(), 2);
        assert_eq!(f.local.groups.len(), 1);
        assert_eq!(f.account.hosts.len(), 1, "seul l'hôte en lecture reste");
    }

    #[test]
    fn local_to_local_and_empty_selection() {
        let mut f = fixture();
        assert!(apply(&mut f.local, &mut f.account, &[f.local_host], Place::Local, Place::Local, false, can_write(f.infra)).is_err());
        assert_eq!(apply(&mut f.local, &mut f.account, &[], Place::Local, Place::Account { vault_id: None }, false, can_write(f.infra)).unwrap(), 0);
    }

    #[test]
    fn list_exposes_parent_ids_for_the_tree() {
        let f = fixture();
        let entries = list(&f.account);
        let host = entries.iter().find(|e| e.id == f.host).unwrap();
        assert_eq!(host.parent_id, Some(f.folder));
        assert_eq!(host.path, "Prod");
        let folder = entries.iter().find(|e| e.id == f.folder).unwrap();
        assert_eq!(folder.parent_id, None);
        assert_eq!(folder.kind, "group");
    }
}
