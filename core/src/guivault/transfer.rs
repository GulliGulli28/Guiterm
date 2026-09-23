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
    for r in &ws.runbooks {
        out.push(EntitySummary { id: r.id, kind: "runbook", name: r.name.clone(), path: String::new(), parent_id: None, vault_id: vault_of(r.id) });
    }
    for c in &ws.sql_connections {
        out.push(EntitySummary { id: c.id, kind: "sql-connection", name: c.label.clone(), path: group_path(ws, c.group_id), parent_id: c.group_id, vault_id: vault_of(c.id) });
    }
    out
}

/// Une entité qui en accompagne une autre, et pourquoi. `required` : sans
/// elle l'arrivée serait incohérente (un hôte rangé dans un dossier qui
/// n'existe pas là-bas, un dossier vidé de son contenu) — elle suit sans
/// qu'on demande. Le reste (clé, icône, bastion, relais Docker, hôte d'un
/// tunnel) est proposé coché, et se décoche : on peut vouloir partager un
/// hôte sans partager son bastion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Follower {
    pub entity: EntitySummary,
    /// « dossier de « web-01 » », « bastion de « db-1 » »…
    pub reason: String,
    pub required: bool,
    /// Ce que ce suiveur facultatif emmène à son tour s'il est gardé (le
    /// dossier et la clé d'un bastion) — une seule case pour tout ça, plutôt
    /// qu'une ligne « obligatoire » qui ne l'est que si on garde le bastion.
    /// Le panneau renvoie ces ids avec celui du suiveur gardé.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub brings: Vec<EntitySummary>,
}

/// Ce qu'une sélection emmène, pour que le panneau le montre avant d'agir.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub followers: Vec<Follower>,
}

fn summary_of(ws: &Workspace, id: Uuid) -> Option<EntitySummary> {
    if let Some(e) = list(ws).into_iter().find(|e| e.id == id) {
        return Some(e);
    }
    ws.custom_icons
        .iter()
        .find(|i| entity::icon_uuid(i) == Some(id))
        .map(|i| EntitySummary { id, kind: "icon", name: i.name.clone(), path: String::new(), parent_id: None, vault_id: ws.vault_bindings.get(&id).copied() })
}

fn folder_chain(ws: &Workspace, mut group_id: Option<Uuid>) -> Vec<Uuid> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    while let Some(gid) = group_id {
        if !seen.insert(gid) {
            break;
        }
        out.push(gid);
        group_id = ws.groups.iter().find(|x| x.id == gid).and_then(|x| x.parent_id);
    }
    out
}

fn icon_dep(ws: &Workspace, icon: &Option<String>, owner: &str) -> Option<(Uuid, String, bool, Reach)> {
    let id = icon.as_deref()?;
    let icon = ws.custom_icons.iter().find(|i| i.id == id)?;
    Some((entity::icon_uuid(icon)?, format!("icône de « {owner} »"), false, Reach::Full))
}

/// Un dossier suit de deux façons : **plein** (choisi, ou contenu d'un
/// dossier choisi — son contenu vient avec lui) ou **en chaîne** (ancêtre
/// d'une entité choisie : il vient pour qu'elle soit rangée à sa place, mais
/// ce qu'il contient d'autre reste où il est).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Reach {
    Full,
    Chain,
}

/// Les dépendances directes d'une entité : `(id, raison, obligatoire, portée)`.
fn dependencies(ws: &Workspace, id: Uuid, reach: Reach) -> Vec<(Uuid, String, bool, Reach)> {
    let mut out = Vec::new();
    if let Some(h) = ws.host(id) {
        let name = &h.label;
        for g in folder_chain(ws, h.group_id) {
            out.push((g, format!("dossier de « {name} »"), true, Reach::Chain));
        }
        if let crate::model::AuthMethod::PrivateKey { key_id: Some(k), .. } = &h.auth
            && ws.keychain.iter().any(|x| x.id == *k)
        {
            out.push((*k, format!("clé de « {name} »"), false, Reach::Full));
        }
        out.extend(icon_dep(ws, &h.icon, name));
        for j in h.jump_via.iter().filter(|j| ws.host(**j).is_some()) {
            out.push((*j, format!("bastion de « {name} »"), false, Reach::Full));
        }
        if let Some(d) = h.docker_via_host_id.filter(|d| ws.host(*d).is_some()) {
            out.push((d, format!("relais Docker de « {name} »"), false, Reach::Full));
        }
    } else if let Some(g) = ws.groups.iter().find(|g| g.id == id) {
        let name = &g.name;
        for p in folder_chain(ws, g.parent_id) {
            out.push((p, format!("dossier parent de « {name} »"), true, Reach::Chain));
        }
        if reach == Reach::Full {
            for child in ws.groups.iter().filter(|x| x.parent_id == Some(id)) {
                out.push((child.id, format!("contenu du dossier « {name} »"), true, Reach::Full));
            }
            for h in ws.hosts.iter().filter(|h| h.group_id == Some(id)) {
                out.push((h.id, format!("contenu du dossier « {name} »"), true, Reach::Full));
            }
            for c in ws.sql_connections.iter().filter(|c| c.group_id == Some(id)) {
                out.push((c.id, format!("contenu du dossier « {name} »"), true, Reach::Full));
            }
        }
        out.extend(icon_dep(ws, &g.icon, name));
    } else if let Some(c) = ws.sql_connections.iter().find(|c| c.id == id) {
        let name = &c.label;
        for g in folder_chain(ws, c.group_id) {
            out.push((g, format!("dossier de « {name} »"), true, Reach::Chain));
        }
        if let Some(crate::model::DbTunnel::SshHost { host_id }) = c.config.tunnel()
            && ws.host(*host_id).is_some()
        {
            out.push((*host_id, format!("hôte du tunnel de « {name} »"), false, Reach::Full));
        }
    }
    out
}

/// Parcourt les dépendances depuis `ids`, en ne suivant que celles que
/// `follow` accepte ; rend l'ensemble (sélection comprise) et, pour chaque
/// suiveur, la première raison rencontrée. Un dossier atteint en chaîne
/// puis en plein est revisité en plein (son contenu suit alors).
fn walk(ws: &Workspace, ids: &[Uuid], follow: impl Fn(&EntitySummary, bool) -> bool) -> (BTreeSet<Uuid>, Vec<Follower>) {
    let mut set: BTreeSet<Uuid> = ids.iter().copied().collect();
    let mut full: BTreeSet<Uuid> = ids.iter().copied().collect();
    let mut followers: Vec<Follower> = Vec::new();
    // `via` : le suiveur facultatif de premier niveau par lequel on est
    // arrivé — ce qui en dépend se range dans son `brings` au lieu d'être
    // une ligne à part.
    let mut queue: Vec<(Uuid, Reach, Option<Uuid>)> = ids.iter().map(|id| (*id, Reach::Full, None)).collect();
    while let Some((id, reach, via)) = queue.pop() {
        for (dep, reason, required, dep_reach) in dependencies(ws, id, reach) {
            let upgrade = dep_reach == Reach::Full && set.contains(&dep) && full.insert(dep);
            if set.contains(&dep) && !upgrade {
                continue;
            }
            let mut next_via = via;
            if !upgrade {
                let Some(entity) = summary_of(ws, dep) else { continue };
                if !follow(&entity, required) {
                    continue;
                }
                set.insert(dep);
                if dep_reach == Reach::Full {
                    full.insert(dep);
                }
                match via {
                    Some(top) => {
                        if let Some(f) = followers.iter_mut().find(|f| f.entity.id == top) {
                            f.brings.push(entity);
                        }
                    }
                    None => {
                        if !required {
                            next_via = Some(dep);
                        }
                        followers.push(Follower { entity, reason, required, brings: Vec::new() });
                    }
                }
            }
            queue.push((dep, dep_reach, next_via));
        }
    }
    (set, followers)
}

/// Tout ce que `ids` emmènerait, obligatoire et facultatif — de proche en
/// proche (le bastion d'un hôte emmène son propre dossier et sa clé). C'est
/// ce que le panneau montre à confirmer.
pub fn plan(ws: &Workspace, ids: &[Uuid]) -> Plan {
    let (_, mut followers) = walk(ws, ids, |_, _| true);
    // Obligatoires d'abord, puis par raison : lisible tel quel.
    followers.sort_by(|a, b| b.required.cmp(&a.required).then_with(|| a.reason.cmp(&b.reason)).then_with(|| a.entity.name.cmp(&b.entity.name)));
    Plan { followers }
}

/// La fermeture **minimale** : la sélection et ce qui doit la suivre
/// (chaînes de dossiers, contenu d'un dossier) — rien d'autre.
pub fn required_closure(ws: &Workspace, ids: &[Uuid]) -> BTreeSet<Uuid> {
    walk(ws, ids, |_, required| required).0
}

/// La fermeture après le [`plan`] : tout ce qui suit, sauf les facultatifs
/// que l'utilisateur a décochés — et ce qui n'était atteint qu'à travers eux
/// (décocher le bastion, c'est aussi ne pas emmener son dossier ni sa clé).
/// Le panneau ne renvoie que les ids décochés : les obligatoires et ce que
/// les gardés emmènent sont recalculés ici, jamais renvoyés — renvoyer un
/// dossier atteint en chaîne comme s'il était choisi emmenait son contenu
/// (bug du 2026-09-18).
pub fn chosen_closure(ws: &Workspace, ids: &[Uuid], dropped: &[Uuid]) -> BTreeSet<Uuid> {
    walk(ws, ids, |e, required| required || !dropped.contains(&e.id)).0
}

/// La fermeture **sans question** : l'obligatoire, plus la clé et l'icône de
/// chaque hôte — ce que le formulaire d'hôte applique quand il change de
/// vault, sans étape de confirmation. Jamais un bastion, un relais ou un
/// hôte de tunnel : ceux-là se demandent.
pub fn closure(ws: &Workspace, ids: &[Uuid]) -> BTreeSet<Uuid> {
    walk(ws, ids, |e, required| required || e.kind == "key" || e.kind == "icon").0
}

/// Déplace `set` (une sélection déjà fermée par [`closure`] ou
/// [`required_closure`]) de `from` vers `to`. Dans `to`, l'affiliation est
/// `vault` (un vault partagé) ou aucune (personnel / local). Rend le nombre
/// d'entités déplacées.
pub fn transfer(from: &mut Workspace, to: &mut Workspace, set: &BTreeSet<Uuid>, vault: Option<VaultId>) -> usize {
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
    move_list!(runbooks, id);
    move_list!(sql_connections, id);
    // Les icônes : par id textuel, et jamais retirées de l'origine — une
    // icône est un décor partagé par tout ce qui la référence.
    for icon in from.custom_icons.iter().filter(|i| entity::icon_uuid(i).is_some_and(|u| set.contains(&u))) {
        if !to.custom_icons.iter().any(|i| i.id == icon.id) {
            to.custom_icons.push(icon.clone());
            moved += 1;
        }
    }
    for id in set {
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
pub fn copy_between(from: &Workspace, to: &mut Workspace, set: &BTreeSet<Uuid>, vault: Option<VaultId>) -> anyhow::Result<usize> {
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
pub fn move_within(ws: &mut Workspace, ids: &[Uuid], set: &BTreeSet<Uuid>, vault: Option<VaultId>) -> usize {
    for id in set {
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

/// Rapatrie dans le personnel tout ce qui est affilié à `vault` — un vault
/// que le compte ne liste plus (accès retiré, vault supprimé) : la synchro
/// suivante retirerait ces entités ; ici on les garde, à soi. Rend le nombre
/// d'entités rapatriées.
pub fn repatriate(ws: &mut Workspace, vault: VaultId) -> usize {
    let before = ws.vault_bindings.len();
    ws.vault_bindings.retain(|_, v| *v != vault);
    before - ws.vault_bindings.len()
}

/// Les vaults partagés d'où `set` sortirait, dans `ws`.
fn source_vaults(ws: &Workspace, set: &BTreeSet<Uuid>) -> BTreeSet<VaultId> {
    set.iter().filter_map(|id| ws.vault_bindings.get(id).copied()).collect()
}

/// Ce qui accompagne la sélection d'un [`Move`].
#[derive(Debug, Clone, Copy)]
pub enum Followers<'a> {
    /// Sans question : l'obligatoire, la clé et l'icône ([`closure`]).
    Quiet,
    /// Après le [`plan`] : tout, sauf ces facultatifs décochés
    /// ([`chosen_closure`]).
    Chosen { dropped: &'a [Uuid] },
}

/// Une demande de déplacement ou de copie, telle que le panneau la formule.
#[derive(Debug, Clone, Copy)]
pub struct Move<'a> {
    pub ids: &'a [Uuid],
    pub from: Place,
    pub to: Place,
    pub copy: bool,
    pub followers: Followers<'a>,
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
pub fn apply(local: &mut Workspace, account: &mut Workspace, mv: Move<'_>, can_write: impl Fn(VaultId) -> bool) -> anyhow::Result<usize> {
    let Move { ids, from, to, copy, followers } = mv;
    if ids.is_empty() {
        return Ok(0);
    }
    if let Some(v) = to.shared_vault()
        && !can_write(v)
    {
        anyhow::bail!("pas de droit d'écriture dans le vault de destination");
    }
    let source = match from {
        Place::Local => &*local,
        Place::Account { .. } => &*account,
    };
    let set = match followers {
        Followers::Quiet => closure(source, ids),
        Followers::Chosen { dropped } => chosen_closure(source, ids, dropped),
    };
    if !copy
        && matches!(from, Place::Account { .. })
        && source_vaults(account, &set).into_iter().any(|v| !can_write(v))
    {
        anyhow::bail!("une des entités vient d'un vault en lecture seule : impossible de l'en retirer");
    }
    match (from, to) {
        (Place::Local, Place::Local) => anyhow::bail!("l'origine et la destination sont toutes deux le profil local"),
        (Place::Local, Place::Account { vault_id }) => {
            if copy {
                copy_between(local, account, &set, vault_id)
            } else {
                Ok(transfer(local, account, &set, vault_id))
            }
        }
        (Place::Account { .. }, Place::Local) => {
            if copy {
                copy_between(account, local, &set, None)
            } else {
                Ok(transfer(account, local, &set, None))
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
                copy_between(&snapshot, account, &set, vault_id)
            } else {
                Ok(move_within(account, ids, &set, vault_id))
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
        assert_eq!(copy_between(&ws, &mut to, &closure(&ws, &[h.id]), None).unwrap(), 2);
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
        let set = closure(&ws, &[h.id]);
        assert_eq!(transfer(&mut ws, &mut to, &set, Some(v)), 3);
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
        let n = apply(&mut f.local, &mut f.account, Move { ids: &[f.local_host], from: Place::Local, to: Place::Account { vault_id: Some(f.infra) }, copy: false, followers: Followers::Quiet }, can_write(f.infra)).unwrap();
        assert_eq!(n, 1);
        assert!(f.local.hosts.is_empty(), "déplacé, pas copié");
        assert_eq!(f.account.vault_bindings.get(&f.local_host), Some(&f.infra));
    }

    #[test]
    fn local_to_read_only_vault_is_refused() {
        let mut f = fixture();
        let err = apply(&mut f.local, &mut f.account, Move { ids: &[f.local_host], from: Place::Local, to: Place::Account { vault_id: Some(f.lecture) }, copy: false, followers: Followers::Quiet }, can_write(f.infra)).unwrap_err();
        assert!(err.to_string().contains("destination"), "{err}");
        assert_eq!(f.local.hosts.len(), 1, "rien n'a bougé");
    }

    #[test]
    fn personal_to_shared_takes_the_folder_along() {
        let mut f = fixture();
        let n = apply(&mut f.local, &mut f.account, Move { ids: &[f.host], from: Place::Account { vault_id: None }, to: Place::Account { vault_id: Some(f.infra) }, copy: false, followers: Followers::Quiet }, can_write(f.infra)).unwrap();
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
        apply(&mut f.local, &mut f.account, Move { ids: &[f.folder], from: Place::Account { vault_id: Some(f.infra) }, to: Place::Account { vault_id: None }, copy: false, followers: Followers::Quiet }, can_write(f.infra)).unwrap();
        assert!(!f.account.vault_bindings.contains_key(&f.folder));
        assert!(!f.account.vault_bindings.contains_key(&f.host), "l'hôte du dossier suit");
    }

    #[test]
    fn same_vault_is_refused() {
        let mut f = fixture();
        let err = apply(&mut f.local, &mut f.account, Move { ids: &[f.host], from: Place::Account { vault_id: None }, to: Place::Account { vault_id: None }, copy: false, followers: Followers::Quiet }, can_write(f.infra)).unwrap_err();
        assert!(err.to_string().contains("même vault"), "{err}");
    }

    #[test]
    fn moving_out_of_read_only_vault_is_refused_but_copying_is_allowed() {
        let mut f = fixture();
        let err = apply(&mut f.local, &mut f.account, Move { ids: &[f.read_only_host], from: Place::Account { vault_id: Some(f.lecture) }, to: Place::Local, copy: false, followers: Followers::Quiet }, can_write(f.infra)).unwrap_err();
        assert!(err.to_string().contains("lecture seule"), "{err}");
        assert_eq!(f.account.hosts.len(), 2);

        let n = apply(&mut f.local, &mut f.account, Move { ids: &[f.read_only_host], from: Place::Account { vault_id: Some(f.lecture) }, to: Place::Local, copy: true, followers: Followers::Quiet }, can_write(f.infra)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(f.account.hosts.len(), 2, "la copie ne retire rien");
        let copied = f.local.hosts.iter().find(|h| h.label == "banque").expect("copié en local");
        assert_ne!(copied.id, f.read_only_host, "nouvel id");
        assert!(f.local.vault_bindings.is_empty(), "le local n'a pas d'affiliation");
    }

    #[test]
    fn copy_between_two_vaults_of_the_account_duplicates_under_new_ids() {
        let mut f = fixture();
        let n = apply(&mut f.local, &mut f.account, Move { ids: &[f.host], from: Place::Account { vault_id: None }, to: Place::Account { vault_id: Some(f.infra) }, copy: true, followers: Followers::Quiet }, can_write(f.infra)).unwrap();
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
        let n = apply(&mut f.local, &mut f.account, Move { ids: &[f.host], from: Place::Account { vault_id: None }, to: Place::Local, copy: false, followers: Followers::Quiet }, can_write(f.infra)).unwrap();
        assert_eq!(n, 2);
        assert_eq!(f.local.hosts.len(), 2);
        assert_eq!(f.local.groups.len(), 1);
        assert_eq!(f.account.hosts.len(), 1, "seul l'hôte en lecture reste");
    }

    #[test]
    fn local_to_local_and_empty_selection() {
        let mut f = fixture();
        assert!(apply(&mut f.local, &mut f.account, Move { ids: &[f.local_host], from: Place::Local, to: Place::Local, copy: false, followers: Followers::Quiet }, can_write(f.infra)).is_err());
        assert_eq!(apply(&mut f.local, &mut f.account, Move { ids: &[], from: Place::Local, to: Place::Account { vault_id: None }, copy: false, followers: Followers::Quiet }, can_write(f.infra)).unwrap(), 0);
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

    // ── `plan` : ce qui suit, obligatoire ou proposé ──────────────────────
    //
    // Prod/ contient db1 (clé « deploy », icône « logo », bastion « jump »
    // rangé dans Accès/) et web1 ; Bases/Catalogue passe par un tunnel sur
    // db1.
    struct Graph {
        ws: Workspace,
        prod: Uuid,
        acces: Uuid,
        db1: Uuid,
        web1: Uuid,
        jump: Uuid,
        key: Uuid,
        icon: Uuid,
        catalogue: Uuid,
    }

    fn graph() -> Graph {
        use crate::model::{AuthMethod, CustomIcon, DbTunnel, EngineConfig, PrivateKey, SqlConnection, SqlEngine};
        let mut ws = Workspace::default();
        let prod = Group { id: Uuid::new_v4(), name: "Prod".into(), parent_id: None, icon: None, color: None };
        let acces = Group { id: Uuid::new_v4(), name: "Accès".into(), parent_id: None, icon: None, color: None };
        let bases = Group { id: Uuid::new_v4(), name: "Bases".into(), parent_id: None, icon: None, color: None };
        let key = PrivateKey { id: Uuid::new_v4(), name: "deploy".into(), path: "~/.ssh/deploy".into(), content: None };
        let icon_id = Uuid::new_v4();
        ws.custom_icons.push(CustomIcon { id: icon_id.to_string(), name: "logo".into(), data_url: "data:,x".into() });
        let mut jump = Host::new("jump", "10.0.0.1", "ops");
        jump.group_id = Some(acces.id);
        let mut db1 = Host::new("db1", "10.0.0.2", "root");
        db1.group_id = Some(prod.id);
        db1.auth = AuthMethod::PrivateKey { path: String::new(), key_id: Some(key.id), cert_path: None };
        db1.icon = Some(icon_id.to_string());
        db1.jump_via = vec![jump.id];
        let mut web1 = Host::new("web1", "10.0.0.3", "root");
        web1.group_id = Some(prod.id);
        let mut catalogue = SqlConnection::new_server("Catalogue", SqlEngine::Postgres, "127.0.0.1", "app");
        catalogue.group_id = Some(bases.id);
        if let EngineConfig::Postgres(c) = &mut catalogue.config {
            c.tunnel = DbTunnel::SshHost { host_id: db1.id };
        }
        ws.groups.extend([prod.clone(), acces.clone(), bases]);
        ws.keychain.push(key.clone());
        ws.hosts.extend([jump.clone(), db1.clone(), web1.clone()]);
        ws.sql_connections.push(catalogue.clone());
        Graph { ws, prod: prod.id, acces: acces.id, db1: db1.id, web1: web1.id, jump: jump.id, key: key.id, icon: icon_id, catalogue: catalogue.id }
    }

    #[test]
    fn plan_lists_required_and_optional_followers_with_reasons() {
        let g = graph();
        let plan = plan(&g.ws, &[g.db1]);
        let by_id: std::collections::BTreeMap<Uuid, &Follower> = plan.followers.iter().map(|f| (f.entity.id, f)).collect();
        assert_eq!(by_id[&g.prod].reason, "dossier de « db1 »");
        assert!(by_id[&g.prod].required);
        assert!(!by_id[&g.key].required);
        assert_eq!(by_id[&g.key].reason, "clé de « db1 »");
        assert_eq!(by_id[&g.icon].kind_of(), "icon");
        assert_eq!(by_id[&g.icon].reason, "icône de « db1 »");
        assert_eq!(by_id[&g.jump].reason, "bastion de « db1 »");
        // Le bastion emmène son dossier — dans sa propre ligne, pas comme un
        // obligatoire à part (il ne l'est que si on garde le bastion).
        assert!(!by_id.contains_key(&g.acces));
        assert_eq!(by_id[&g.jump].brings.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Accès"]);
        // Le dossier Prod suit en chaîne : web1, qui y est aussi, ne suit pas.
        assert!(!by_id.contains_key(&g.web1), "{:?}", plan.followers.iter().map(|f| &f.entity.name).collect::<Vec<_>>());
        // Les obligatoires viennent en tête.
        let first_optional = plan.followers.iter().position(|f| !f.required).unwrap();
        assert!(plan.followers[..first_optional].iter().all(|f| f.required));
    }

    impl Follower {
        fn kind_of(&self) -> &'static str {
            self.entity.kind
        }
    }

    #[test]
    fn a_connection_proposes_its_tunnel_host() {
        let g = graph();
        let plan = plan(&g.ws, &[g.catalogue]);
        let tunnel = plan.followers.iter().find(|f| f.entity.id == g.db1).expect("hôte du tunnel");
        assert_eq!(tunnel.reason, "hôte du tunnel de « Catalogue »");
        assert!(!tunnel.required);
        // Et de proche en proche : ce que cet hôte emmène (dossier, clé,
        // icône, bastion et son dossier) vient avec lui, dans sa ligne.
        let brings: Vec<&str> = tunnel.brings.iter().map(|e| e.name.as_str()).collect();
        for expected in ["Prod", "deploy", "logo", "jump", "Accès"] {
            assert!(brings.contains(&expected), "{expected} manque dans {brings:?}");
        }
        assert!(!plan.followers.iter().any(|f| f.entity.id == g.key), "pas de ligne à part");
    }

    #[test]
    fn a_chosen_folder_takes_its_content_but_a_chained_one_does_not() {
        let g = graph();
        let chosen = required_closure(&g.ws, &[g.prod]);
        assert!(chosen.contains(&g.db1) && chosen.contains(&g.web1), "contenu du dossier choisi");
        assert!(!chosen.contains(&g.jump) && !chosen.contains(&g.key), "l'obligatoire seul");
        let chained = required_closure(&g.ws, &[g.db1]);
        assert_eq!(chained, [g.db1, g.prod].into_iter().collect());
    }

    #[test]
    fn closure_without_question_takes_key_and_icon_but_never_a_bastion() {
        let g = graph();
        let set = closure(&g.ws, &[g.db1]);
        assert_eq!(set, [g.db1, g.prod, g.key, g.icon].into_iter().collect());
    }

    #[test]
    fn exact_apply_moves_only_what_was_kept_and_icons_are_copied_not_removed() {
        let mut g = graph();
        let mut local = Workspace::default();
        let v = Uuid::new_v4();
        // L'utilisateur a gardé l'icône et décoché la clé et le bastion.
        let dropped = [g.key, g.jump];
        let n = apply(&mut local, &mut g.ws, Move { ids: &[g.db1], from: Place::Account { vault_id: None }, to: Place::Account { vault_id: Some(v) }, copy: false, followers: Followers::Chosen { dropped: &dropped } }, |x| x == v).unwrap();
        assert_eq!(n, 3, "db1, Prod, l'icône");
        assert_eq!(g.ws.vault_bindings.get(&g.db1), Some(&v));
        assert_eq!(g.ws.vault_bindings.get(&g.icon), Some(&v));
        assert!(!g.ws.vault_bindings.contains_key(&g.key), "décochée");
        assert!(!g.ws.vault_bindings.contains_key(&g.jump), "décoché");
        assert!(!g.ws.vault_bindings.contains_key(&g.acces), "le dossier du bastion décoché ne suit pas non plus");

        // Vers l'appareil : l'icône est copiée, l'origine la garde (web1
        // pourrait encore la porter).
        let n = apply(&mut local, &mut g.ws, Move { ids: &[g.db1], from: Place::Account { vault_id: Some(v) }, to: Place::Local, copy: false, followers: Followers::Chosen { dropped: &dropped } }, |x| x == v).unwrap();
        assert_eq!(n, 3);
        assert_eq!(local.custom_icons.len(), 1);
        assert_eq!(g.ws.custom_icons.len(), 1, "l'icône reste aussi à l'origine");
        assert!(local.hosts.iter().any(|h| h.id == g.db1));
    }

    #[test]
    fn repatriate_unbinds_only_that_vault() {
        let mut ws = Workspace::default();
        let (gone, kept) = (Uuid::new_v4(), Uuid::new_v4());
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        ws.vault_bindings.insert(a, gone);
        ws.vault_bindings.insert(b, gone);
        ws.vault_bindings.insert(c, kept);
        assert_eq!(repatriate(&mut ws, gone), 2);
        assert_eq!(ws.vault_bindings.len(), 1);
        assert_eq!(ws.vault_bindings.get(&c), Some(&kept));
    }

    // Le bug du 2026-09-18 : copier un sous-dossier copiait aussi les autres
    // dossiers de son parent. Le panneau renvoyait les suiveurs *obligatoires*
    // (le dossier parent, atteint en chaîne) dans `ids`, et `apply` les
    // prenait pour une sélection pleine — avec leur contenu. Ce test joue le
    // flux tel que le panneau le joue : cocher le dossier (lui et son
    // sous-arbre), demander le plan, garder tout ce qui est proposé, appliquer.
    #[test]
    fn copying_a_subfolder_never_takes_its_siblings() {
        let mut ws = Workspace::default();
        let parent = Group { id: Uuid::new_v4(), name: "Prod".into(), parent_id: None, icon: None, color: None };
        let sub = Group { id: Uuid::new_v4(), name: "Bases".into(), parent_id: Some(parent.id), icon: None, color: None };
        let sibling = Group { id: Uuid::new_v4(), name: "Web".into(), parent_id: Some(parent.id), icon: None, color: None };
        let mut pg = Host::new("pg", "10.0.0.1", "root");
        pg.group_id = Some(sub.id);
        let mut web = Host::new("web", "10.0.0.2", "root");
        web.group_id = Some(sibling.id);
        let mut loose = Host::new("loose", "10.0.0.3", "root");
        loose.group_id = Some(parent.id);
        ws.groups.extend([parent.clone(), sub.clone(), sibling.clone()]);
        ws.hosts.extend([pg.clone(), web.clone(), loose.clone()]);

        // La case du dossier « Bases » : lui et son sous-arbre.
        let checked = [sub.id, pg.id];
        let plan = plan(&ws, &checked);
        assert!(plan.followers.iter().any(|f| f.entity.id == parent.id && f.required), "le parent suit en chaîne");
        assert!(!plan.followers.iter().any(|f| f.entity.id == sibling.id || f.entity.id == web.id || f.entity.id == loose.id), "{:?}", plan.followers.iter().map(|f| &f.entity.name).collect::<Vec<_>>());
        // Le panneau ne renvoie que ce qui a été décoché (rien ici) ; tout
        // le reste est recalculé.
        let ids = checked.to_vec();
        let v = Uuid::new_v4();
        let mut local = Workspace::default();
        let n = apply(&mut local, &mut ws, Move { ids: &ids, from: Place::Account { vault_id: None }, to: Place::Account { vault_id: Some(v) }, copy: true, followers: Followers::Chosen { dropped: &[] } }, |x| x == v).unwrap();
        assert_eq!(n, 3, "Bases, pg et Prod (en chaîne) — rien d'autre");
        let copied: Vec<&str> = ws.groups.iter().chain([].iter()).filter(|g| ws.vault_bindings.get(&g.id) == Some(&v)).map(|g| g.name.as_str()).collect();
        assert_eq!(copied, ["Prod", "Bases"], "{copied:?}");
        assert_eq!(ws.hosts.iter().filter(|h| ws.vault_bindings.get(&h.id) == Some(&v)).count(), 1);
        // Et un déplacement, même règle.
        let n = apply(&mut local, &mut ws, Move { ids: &ids, from: Place::Account { vault_id: None }, to: Place::Local, copy: false, followers: Followers::Chosen { dropped: &[] } }, |x| x == v).unwrap();
        assert_eq!(n, 3);
        assert!(ws.groups.iter().any(|g| g.id == sibling.id) && ws.hosts.iter().any(|h| h.id == web.id || h.id == loose.id), "les frères restent");
    }

    /// Tout suiveur obligatoire du plan est retrouvé par la fermeture
    /// obligatoire — c'est ce qui autorise le panneau à ne renvoyer que les
    /// facultatifs gardés (avec ce qu'ils emmènent) ; et tout garder
    /// redonne exactement la fermeture complète.
    #[test]
    fn required_followers_are_recomputed_by_required_closure() {
        let g = graph();
        for ids in [vec![g.db1], vec![g.prod], vec![g.catalogue], vec![g.db1, g.catalogue]] {
            let plan = plan(&g.ws, &ids);
            let closure = required_closure(&g.ws, &ids);
            for f in plan.followers.iter().filter(|f| f.required) {
                assert!(closure.contains(&f.entity.id), "{} manque pour {ids:?}", f.entity.name);
            }
            // Rien décoché = tout ce que le plan a listé, `brings` compris.
            let (everything, _) = walk(&g.ws, &ids, |_, _| true);
            assert_eq!(chosen_closure(&g.ws, &ids, &[]), everything, "pour {ids:?}");
            // Tout décoché = l'obligatoire seul.
            let optional: Vec<Uuid> = plan.followers.iter().filter(|f| !f.required).map(|f| f.entity.id).collect();
            assert_eq!(chosen_closure(&g.ws, &ids, &optional), closure, "pour {ids:?}");
        }
    }
}
