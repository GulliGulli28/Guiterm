//! Déplacer des entités entre deux workspaces (le profil local et celui du
//! compte), ou entre vaults d'un même compte — depuis le menu des vaults,
//! à tout moment, pas seulement à la première connexion.
//!
//! Une entité ne part jamais seule : un hôte emmène sa chaîne de dossiers
//! et sa clé du trousseau, un dossier emmène son sous-arbre (dossiers et
//! hôtes). Sans ça, l'arrivée serait un hôte rangé « nulle part » ou une
//! clé qui manque. Les secrets ne bougent pas : ils sont dans le coffre
//! local, indexés par l'id de l'entité, qui ne change pas.
use crate::model::{VaultId, Workspace};
use serde::Serialize;
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
    /// Vault partagé d'affiliation, `None` = personnel (ou local).
    pub vault_id: Option<VaultId>,
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
        out.push(EntitySummary { id: g.id, kind: "group", name: g.name.clone(), path: group_path(ws, g.parent_id), vault_id: vault_of(g.id) });
    }
    for h in &ws.hosts {
        out.push(EntitySummary { id: h.id, kind: "host", name: h.label.clone(), path: group_path(ws, h.group_id), vault_id: vault_of(h.id) });
    }
    for k in &ws.keychain {
        out.push(EntitySummary { id: k.id, kind: "key", name: k.name.clone(), path: String::new(), vault_id: vault_of(k.id) });
    }
    for s in &ws.snippets {
        out.push(EntitySummary { id: s.id, kind: "snippet", name: s.name.clone(), path: String::new(), vault_id: vault_of(s.id) });
    }
    for c in &ws.sql_connections {
        out.push(EntitySummary { id: c.id, kind: "sql-connection", name: c.label.clone(), path: group_path(ws, c.group_id), vault_id: vault_of(c.id) });
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Group, Host};

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
}
