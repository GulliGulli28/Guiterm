//! Parcourir le contenu du compte — tout ce que l'extension web montre,
//! identifiants et notes compris — pour copier ou coller une valeur dans un
//! terminal.
//!
//! **Lecture seule, à côté de `sync.rs`, jamais à travers.** La synchro ne
//! connaît que les entités de Guiterm (hôtes, dossiers, clés, snippets,
//! connexions) ; les secrets de l'interface web (`login`, `note`, `card`,
//! `identity` — `guivault-items`) la traversent sans bruit, et surtout sans
//! entrer dans son état : un item connu de `state.items` mais absent du
//! workspace y passerait pour une suppression locale et serait **effacé côté
//! serveur** (`docs/ITEMS.md` de GuiVault, test
//! `web_secrets_are_left_alone_by_sync`). Ce module lit donc les items lui-même,
//! tous types confondus, et n'écrit rien nulle part.
//!
//! Ce qui reste en mémoire entre deux ouvertures du panneau : les items
//! **chiffrés** de chaque vault, avec la révision qui les a produits — on ne
//! re-télécharge que les vaults dont la révision a bougé, comme l'extension.
//! Le déchiffrement se fait à la demande : [`list`] rend l'arbre en
//! métadonnées seules (nom, dossier, tags, *quels* champs existent), et
//! [`read_field`] rend **une** valeur au moment du copier/coller. Un mot de
//! passe ne traverse donc l'IPC qu'au moment où l'utilisateur le demande, et
//! le frontend n'en garde aucun.
use super::account::Manager;
use super::entity::Payload;
use crate::model::{EngineConfig, HostKind, VaultId};
use guivault_crypto as gc;
use guivault_items::{FieldType, SecretItem};
use guivault_protocol::{self as proto, VaultKind};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

/// Les items chiffrés déjà reçus, par vault. Vide au démarrage ; à vider à
/// la déconnexion (un autre compte ne verrait de toute façon que du chiffré
/// qu'il ne peut pas ouvrir, mais autant ne rien garder qui ne soit à lui).
#[derive(Default)]
pub struct Cache {
    vaults: HashMap<VaultId, CachedVault>,
}

struct CachedVault {
    revision: i64,
    items: Vec<proto::Item>,
}

/// Ce que [`fetch`] a rapporté : les vaults à remplacer dans le cache, et
/// ceux qui existent encore (les autres partent).
pub struct Fetched {
    pub vaults: Vec<(VaultId, i64, Vec<proto::Item>)>,
    pub alive: Vec<VaultId>,
}

impl Cache {
    /// Les révisions connues — ce qu'il faut donner à [`fetch`].
    pub fn revisions(&self) -> HashMap<VaultId, i64> {
        self.vaults.iter().map(|(id, v)| (*id, v.revision)).collect()
    }

    pub fn absorb(&mut self, fetched: Fetched) {
        self.vaults.retain(|id, _| fetched.alive.contains(id));
        for (id, revision, items) in fetched.vaults {
            self.vaults.insert(id, CachedVault { revision, items });
        }
    }

    pub fn clear(&mut self) {
        self.vaults.clear();
    }

    fn item(&self, vault: VaultId, id: Uuid) -> Option<&proto::Item> {
        self.vaults.get(&vault)?.items.iter().find(|i| i.id == id)
    }
}

/// Le réseau, hors de tout verrou : la liste des vaults et leurs révisions
/// (`/sync`), puis les items des seuls vaults qui ont bougé depuis `known`.
/// Sans `since` : la page rend tous les items vivants, sans tombale — c'est
/// exactement ce qu'on veut afficher.
pub async fn fetch(manager: &Manager, known: &HashMap<VaultId, i64>) -> anyhow::Result<Fetched> {
    let client = manager.client()?;
    let _account = manager.account()?;
    let remote = client.sync().await.map_err(super::account::user_error)?;
    manager.update_session(|s| s.absorb_vaults(&remote.vaults))?;
    let infos = manager.vault_infos();
    let mut fetched = Fetched { vaults: Vec::new(), alive: infos.iter().map(|v| v.id).collect() };
    for v in infos {
        if known.get(&v.id).is_some_and(|k| *k >= v.revision) {
            continue;
        }
        let page = client.items(v.id, None).await.map_err(super::account::user_error)?;
        let items = page.items.into_iter().filter(|i| !i.deleted).collect();
        fetched.vaults.push((v.id, v.revision, items));
    }
    manager.persist_tokens();
    Ok(fetched)
}

// ─── Ce qu'on montre ────────────────────────────────────────────────────────

/// Un item du compte, sans aucune valeur secrète : de quoi le ranger dans
/// l'arbre, le chercher, et savoir quels champs proposer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: Uuid,
    pub vault_id: VaultId,
    pub vault_name: String,
    /// `host` | `group` | `key` | `snippet` | `sql-connection` | `login` |
    /// `note` | `card` | `identity`. Les icônes ne sont pas listées.
    pub kind: String,
    pub name: String,
    /// Le dossier (`group`) qui contient l'item, `None` à la racine du vault.
    pub parent_id: Option<Uuid>,
    pub tags: Vec<String>,
    /// Termes que la recherche accepte sans les afficher : l'utilisateur,
    /// l'adresse, les sites d'un identifiant.
    pub search: String,
    pub fields: Vec<Field>,
}

/// Un champ copiable/collable d'un item — sa valeur reste côté Rust jusqu'à
/// [`read_field`].
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    /// Ce que [`read_field`] attend (`password`, `env:TOKEN`, `field:2`…).
    pub key: String,
    pub label: String,
    /// À masquer à l'affichage (mot de passe, code de carte, passphrase…).
    pub secret: bool,
    /// Plusieurs lignes (note, snippet, clé) : le coller n'est pas une frappe
    /// d'une ligne.
    pub multiline: bool,
    /// Un secret TOTP : la valeur n'est pas à copier telle quelle, c'est
    /// [`totp`] qui rend le code du moment.
    pub totp: bool,
}

/// Un code TOTP et ce qu'il lui reste à vivre — pour l'afficher avec son
/// compte à rebours et le renouveler à temps.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    pub code: String,
    pub ttl_secs: u64,
    pub period_secs: u64,
}

/// Un item ouvert : ses métadonnées et ses valeurs, le temps d'un appel.
struct Opened {
    name: String,
    parent_id: Option<Uuid>,
    tags: Vec<String>,
    search: Vec<String>,
    fields: Vec<(Field, String)>,
}

impl Opened {
    fn new(name: &str, parent_id: Option<Uuid>, tags: &[String]) -> Self {
        Opened { name: name.to_string(), parent_id, tags: tags.to_vec(), search: Vec::new(), fields: Vec::new() }
    }

    /// Un champ vide n'est pas proposé : rien à copier.
    fn text(&mut self, key: &str, label: &str, value: &str) -> &mut Self {
        self.push(key, label, value, false, false)
    }

    fn secret(&mut self, key: &str, label: &str, value: &str) -> &mut Self {
        self.push(key, label, value, true, false)
    }

    fn multiline(&mut self, key: &str, label: &str, value: &str, secret: bool) -> &mut Self {
        self.push(key, label, value, secret, true)
    }

    fn push(&mut self, key: &str, label: &str, value: &str, secret: bool, multiline: bool) -> &mut Self {
        if !value.trim().is_empty() {
            self.fields.push((
                Field { key: key.to_string(), label: label.to_string(), secret, multiline, totp: false },
                value.to_string(),
            ));
        }
        self
    }

    fn totp(&mut self, value: &Option<String>) {
        if let Some(v) = value.as_deref().filter(|v| !v.trim().is_empty()) {
            self.fields.push((
                Field { key: "totp".into(), label: "Code TOTP".into(), secret: true, multiline: false, totp: true },
                v.to_string(),
            ));
        }
    }

    fn searchable(&mut self, term: &str) {
        if !term.trim().is_empty() {
            self.search.push(term.to_string());
        }
    }

    /// Les notes et champs libres communs aux quatre types de secrets.
    fn secret_base(&mut self, base: &guivault_items::SecretBase) {
        if let Some(n) = &base.notes {
            self.multiline("notes", "Notes", n, false);
        }
        for (i, f) in base.fields.iter().flatten().enumerate() {
            let label = if f.name.trim().is_empty() { format!("Champ {}", i + 1) } else { f.name.clone() };
            match f.r#type {
                FieldType::Hidden => self.secret(&format!("field:{i}"), &label, &f.value),
                FieldType::Text | FieldType::Boolean => self.text(&format!("field:{i}"), &label, &f.value),
            };
        }
    }
}

/// Ouvre le JSON en clair d'un item. `None` pour ce qui n'a rien à montrer
/// (une icône) ; une erreur pour ce qui ne se lit pas.
fn open(item_type: &str, plain: &[u8]) -> anyhow::Result<Option<Opened>> {
    if SecretItem::is_secret_type(item_type) {
        return Ok(Some(open_secret(SecretItem::from_json(plain)?)));
    }
    Ok(open_entity(Payload::from_json(plain)?))
}

fn open_secret(item: SecretItem) -> Opened {
    match item {
        SecretItem::Login { login } => {
            let mut o = Opened::new(&login.base.name, login.base.group_id, &login.base.tags);
            o.searchable(&login.username);
            for u in &login.uris {
                o.searchable(&u.uri);
            }
            o.text("username", "Utilisateur", &login.username).secret("password", "Mot de passe", &login.password);
            o.totp(&login.totp);
            for (i, u) in login.uris.iter().enumerate() {
                o.text(&format!("uri:{i}"), "Site", &u.uri);
            }
            o.secret_base(&login.base);
            o
        }
        SecretItem::Note { note } => {
            let mut o = Opened::new(&note.base.name, note.base.group_id, &note.base.tags);
            o.multiline("content", "Contenu", &note.content, false);
            o.secret_base(&note.base);
            o
        }
        SecretItem::Card { card } => {
            let mut o = Opened::new(&card.base.name, card.base.group_id, &card.base.tags);
            o.searchable(&card.brand);
            o.text("cardholderName", "Titulaire", &card.cardholder_name)
                .text("brand", "Réseau", &card.brand)
                .secret("number", "Numéro", &card.number);
            let exp = match (card.exp_month.trim(), card.exp_year.trim()) {
                ("", "") => String::new(),
                (m, "") => m.to_string(),
                ("", y) => y.to_string(),
                (m, y) => format!("{m}/{y}"),
            };
            o.text("expiration", "Expiration", &exp).secret("code", "Code de sécurité", &card.code);
            o.secret_base(&card.base);
            o
        }
        SecretItem::Identity { identity: id } => {
            let mut o = Opened::new(&id.base.name, id.base.group_id, &id.base.tags);
            o.searchable(&id.username);
            o.searchable(&id.email);
            let full_name = [id.title.as_str(), id.first_name.as_str(), id.middle_name.as_str(), id.last_name.as_str()]
                .iter()
                .filter(|s| !s.trim().is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" ");
            o.text("fullName", "Nom complet", &full_name)
                .text("username", "Utilisateur", &id.username)
                .text("email", "E-mail", &id.email)
                .text("phone", "Téléphone", &id.phone)
                .text("company", "Société", &id.company)
                .secret("ssn", "Numéro de sécurité sociale", &id.ssn)
                .secret("passportNumber", "Passeport", &id.passport_number)
                .secret("licenseNumber", "Permis", &id.license_number);
            let address = [id.address1.as_str(), id.address2.as_str(), id.address3.as_str()]
                .iter()
                .filter(|s| !s.trim().is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
            o.multiline("address", "Adresse", &address, false)
                .text("city", "Ville", &id.city)
                .text("state", "Région", &id.state)
                .text("postalCode", "Code postal", &id.postal_code)
                .text("country", "Pays", &id.country);
            o.secret_base(&id.base);
            o
        }
    }
}

fn open_entity(payload: Payload) -> Option<Opened> {
    Some(match payload {
        Payload::Host { host, secrets } => {
            let mut o = Opened::new(&host.label, host.group_id, &host.tags);
            o.searchable(&host.address);
            o.searchable(&host.username);
            if matches!(host.kind, HostKind::Ssh) {
                let cmd = if host.port == 22 {
                    format!("ssh {}@{}", host.username, host.address)
                } else {
                    format!("ssh -p {} {}@{}", host.port, host.username, host.address)
                };
                o.text("sshCommand", "Commande SSH", &cmd);
            }
            o.text("address", "Adresse", &host.address).text("username", "Utilisateur", &host.username);
            if let Some(p) = &secrets.password {
                o.secret("password", "Mot de passe", p);
            }
            if let Some(p) = &secrets.passphrase {
                o.secret("passphrase", "Passphrase de la clé", p);
            }
            for (k, v) in &secrets.env {
                o.secret(&format!("env:{k}"), &format!("Variable {k}"), v);
            }
            o
        }
        Payload::Group { group } => Opened::new(&group.name, group.parent_id, &[]),
        Payload::Snippet { snippet } => {
            let mut o = Opened::new(&snippet.name, None, &snippet.tags);
            o.multiline("command", "Commande", &snippet.command, false);
            o
        }
        Payload::Key { key, content, passphrase } => {
            let mut o = Opened::new(&key.name, None, &[]);
            o.text("path", "Chemin", &key.path);
            if let Some(p) = &passphrase {
                o.secret("passphrase", "Passphrase", p);
            }
            if let Some(c) = &content {
                o.multiline("content", "Clé privée", c, true);
            }
            o
        }
        Payload::SqlConnection { connection, password } => {
            let mut o = Opened::new(&connection.label, connection.group_id, &connection.tags);
            match &connection.config {
                EngineConfig::Mysql(c) | EngineConfig::Postgres(c) | EngineConfig::Redis(c) => {
                    o.searchable(&c.address);
                    o.searchable(&c.username);
                    o.text("address", "Adresse", &c.address)
                        .text("port", "Port", &c.port.to_string())
                        .text("username", "Utilisateur", &c.username)
                        .text("database", "Base", c.database.as_deref().unwrap_or(""));
                }
                EngineConfig::Mongodb(c) => {
                    o.searchable(&c.username);
                    o.secret("connectionString", "Chaîne de connexion", &c.connection_string)
                        .text("username", "Utilisateur", &c.username);
                }
                EngineConfig::Sqlite(_) => {}
            }
            if let Some(p) = &password {
                o.secret("password", "Mot de passe", p);
            }
            o
        }
        Payload::Icon { .. } => return None,
    })
}

fn decrypt(manager: &Manager, item: &proto::Item) -> anyhow::Result<Vec<u8>> {
    let vault = manager.vault_info(item.vault_id)?;
    gc::open_item(&vault.key, &item.vault_id.to_string(), &item.id.to_string(), &item.item_type, &item.ciphertext)
        .map_err(|e| anyhow::anyhow!("item illisible : {e}"))
}

/// Tout ce que le compte contient, vault personnel en tête puis les
/// partagés par nom, et dans un vault par nom. Un item illisible est passé
/// (c'est un panneau de consultation, pas un rapport de synchro).
pub fn list(manager: &Manager, cache: &Cache) -> anyhow::Result<Vec<Entry>> {
    let _ = manager.account()?;
    let mut infos = manager.vault_infos();
    infos.sort_by_key(|v| (v.kind != VaultKind::Personal, v.name.to_lowercase()));
    let mut out = Vec::new();
    for v in infos {
        let Some(cached) = cache.vaults.get(&v.id) else { continue };
        let mut entries = Vec::new();
        for item in &cached.items {
            let Ok(plain) = decrypt(manager, item) else { continue };
            let Ok(Some(opened)) = open(&item.item_type, &plain) else { continue };
            entries.push(Entry {
                id: item.id,
                vault_id: v.id,
                vault_name: v.name.clone(),
                kind: item.item_type.clone(),
                name: opened.name,
                parent_id: opened.parent_id,
                tags: opened.tags,
                search: opened.search.join(" "),
                fields: opened.fields.into_iter().map(|(f, _)| f).collect(),
            });
        }
        entries.sort_by_key(|e| e.name.to_lowercase());
        out.extend(entries);
    }
    Ok(out)
}

fn open_cached(manager: &Manager, cache: &Cache, vault: VaultId, id: Uuid) -> anyhow::Result<Opened> {
    let item = cache.item(vault, id).ok_or_else(|| anyhow::anyhow!("item inconnu — rouvrir le panneau pour le relire"))?;
    let plain = decrypt(manager, item)?;
    open(&item.item_type, &plain)?.ok_or_else(|| anyhow::anyhow!("cet item n'a rien à copier"))
}

/// La valeur d'**un** champ, au moment où l'utilisateur la demande.
pub fn read_field(manager: &Manager, cache: &Cache, vault: VaultId, id: Uuid, key: &str) -> anyhow::Result<String> {
    let opened = open_cached(manager, cache, vault, id)?;
    opened
        .fields
        .into_iter()
        .find(|(f, _)| f.key == key && !f.totp)
        .map(|(_, v)| v)
        .ok_or_else(|| anyhow::anyhow!("champ « {key} » absent de cet item"))
}

/// Le code TOTP du moment d'un identifiant.
pub fn totp(manager: &Manager, cache: &Cache, vault: VaultId, id: Uuid) -> anyhow::Result<TotpCode> {
    let opened = open_cached(manager, cache, vault, id)?;
    let secret = opened
        .fields
        .into_iter()
        .find(|(f, _)| f.totp)
        .map(|(_, v)| v)
        .ok_or_else(|| anyhow::anyhow!("cet identifiant n'a pas de code TOTP"))?;
    totp_code(&secret)
}

/// Un secret TOTP tel que l'interface web l'enregistre : une URI
/// `otpauth://totp/...`, ou le secret base32 nu (SHA-1, 6 chiffres, 30 s —
/// ce que font Google Authenticator et la quasi-totalité des sites).
pub fn totp_code(secret: &str) -> anyhow::Result<TotpCode> {
    use totp_rs::{Algorithm, Secret, TOTP};
    let secret = secret.trim();
    let totp = if secret.starts_with("otpauth://") {
        TOTP::from_url_unchecked(secret).map_err(|e| anyhow::anyhow!("URI otpauth invalide : {e}"))?
    } else {
        let compact: String = secret.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase();
        let bytes = Secret::Encoded(compact).to_bytes().map_err(|_| anyhow::anyhow!("secret TOTP invalide (base32 attendu)"))?;
        TOTP::new_unchecked(Algorithm::SHA1, 6, 1, 30, bytes, None, String::new())
    };
    let code = totp.generate_current().map_err(|e| anyhow::anyhow!("horloge système illisible : {e}"))?;
    let ttl_secs = totp.ttl().map_err(|e| anyhow::anyhow!("horloge système illisible : {e}"))?;
    Ok(TotpCode { code, ttl_secs, period_secs: totp.step })
}

/// Pour les tests : les entrées et valeurs d'un JSON en clair, sans compte.
#[doc(hidden)]
pub fn describe_plain(item_type: &str, plain: &[u8]) -> anyhow::Result<Option<(Entry, BTreeMap<String, String>)>> {
    let Some(o) = open(item_type, plain)? else { return Ok(None) };
    let values = o.fields.iter().map(|(f, v)| (f.key.clone(), v.clone())).collect();
    let entry = Entry {
        id: Uuid::nil(),
        vault_id: Uuid::nil(),
        vault_name: String::new(),
        kind: item_type.to_string(),
        name: o.name,
        parent_id: o.parent_id,
        tags: o.tags,
        search: o.search.join(" "),
        fields: o.fields.into_iter().map(|(f, _)| f).collect(),
    };
    Ok(Some((entry, values)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Host, Snippet};

    fn keys(entry: &Entry) -> Vec<&str> {
        entry.fields.iter().map(|f| f.key.as_str()).collect()
    }

    #[test]
    fn a_login_written_by_the_web_ui_lists_its_fields_without_their_values() {
        // Le JSON tel que l'interface web l'écrit (`docs/ITEMS.md`).
        let json = r#"{"kind":"login","login":{"id":"6f1d5b3e-0d5c-4c39-9f4e-1f0a2b3c4d5e","name":"GitHub",
            "groupId":"0a0b0c0d-0000-4000-8000-000000000001","tags":["dev"],"username":"alice","password":"s3cret",
            "uris":[{"uri":"https://github.com"}],"totp":"JBSWY3DPEHPK3PXP","notes":"compte perso",
            "fields":[{"name":"API token","value":"tok","type":"hidden"},{"name":"Plan","value":"pro","type":"text"}]}}"#;
        let (entry, values) = describe_plain("login", json.as_bytes()).unwrap().unwrap();
        assert_eq!(entry.name, "GitHub");
        assert_eq!(entry.parent_id, Some("0a0b0c0d-0000-4000-8000-000000000001".parse().unwrap()));
        assert_eq!(entry.tags, vec!["dev"]);
        assert!(entry.search.contains("alice") && entry.search.contains("github.com"));
        assert_eq!(keys(&entry), ["username", "password", "totp", "uri:0", "notes", "field:0", "field:1"]);
        let password = entry.fields.iter().find(|f| f.key == "password").unwrap();
        assert!(password.secret && !password.multiline && !password.totp);
        assert!(entry.fields.iter().find(|f| f.key == "totp").unwrap().totp);
        assert!(entry.fields.iter().find(|f| f.key == "field:0").unwrap().secret);
        assert!(!entry.fields.iter().find(|f| f.key == "field:1").unwrap().secret);
        assert_eq!(entry.fields.iter().find(|f| f.key == "field:0").unwrap().label, "API token");
        // Les valeurs sont à côté, jamais dans l'`Entry` sérialisée.
        assert_eq!(values["password"], "s3cret");
        assert!(!serde_json::to_string(&entry).unwrap().contains("s3cret"));
    }

    #[test]
    fn empty_fields_are_not_offered() {
        let json = r#"{"kind":"note","note":{"id":"6f1d5b3e-0d5c-4c39-9f4e-1f0a2b3c4d5e","name":"Vide","content":""}}"#;
        let (entry, _) = describe_plain("note", json.as_bytes()).unwrap().unwrap();
        assert!(entry.fields.is_empty());
        let json = r#"{"kind":"card","card":{"id":"6f1d5b3e-0d5c-4c39-9f4e-1f0a2b3c4d5e","name":"Visa","number":"4111",
            "expMonth":"12","expYear":"2030","code":"123"}}"#;
        let (entry, values) = describe_plain("card", json.as_bytes()).unwrap().unwrap();
        assert_eq!(keys(&entry), ["number", "expiration", "code"]);
        assert_eq!(values["expiration"], "12/2030");
    }

    #[test]
    fn guiterm_entities_expose_their_secrets_and_a_ready_ssh_command() {
        let mut host = Host::new("web-1", "10.0.0.5", "deploy");
        host.port = 2222;
        let payload = Payload::Host {
            host,
            secrets: super::super::entity::HostSecrets {
                password: Some("pw".into()),
                passphrase: None,
                env: [("TOKEN".to_string(), "abc".to_string())].into_iter().collect(),
            },
        };
        let json = payload.to_json().unwrap();
        let (entry, values) = describe_plain("host", json.as_bytes()).unwrap().unwrap();
        assert_eq!(keys(&entry), ["sshCommand", "address", "username", "password", "env:TOKEN"]);
        assert_eq!(values["sshCommand"], "ssh -p 2222 deploy@10.0.0.5");
        assert!(entry.fields.iter().find(|f| f.key == "env:TOKEN").unwrap().secret);

        let snippet = Snippet { id: Uuid::new_v4(), name: "Deux lignes".into(), command: "ls\npwd".into(), tags: vec![], adaptive: false };
        let json = Payload::Snippet { snippet }.to_json().unwrap();
        let (entry, _) = describe_plain("snippet", json.as_bytes()).unwrap().unwrap();
        assert!(entry.fields[0].multiline);

        let json = r#"{"kind":"icon","icon":{"id":"6f1d5b3e-0d5c-4c39-9f4e-1f0a2b3c4d5e","name":"x","dataUrl":"data:image/svg+xml;base64,"}}"#;
        assert!(describe_plain("icon", json.as_bytes()).unwrap().is_none(), "une icône n'a rien à copier");
    }

    #[test]
    fn a_totp_secret_gives_a_six_digit_code_from_a_bare_base32_or_an_otpauth_uri() {
        let bare = totp_code("jbsw y3dp ehpk 3pxp").unwrap();
        assert_eq!(bare.code.len(), 6);
        assert!(bare.code.chars().all(|c| c.is_ascii_digit()));
        assert!(bare.ttl_secs >= 1 && bare.ttl_secs <= 30);
        assert_eq!(bare.period_secs, 30);
        let uri = totp_code("otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub").unwrap();
        assert_eq!(uri.code, bare.code, "même secret, même code");
        assert!(totp_code("pas du base32 !").is_err());
    }

    #[test]
    fn the_cache_forgets_vaults_that_are_gone_and_keeps_the_others() {
        let mut cache = Cache::default();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        cache.absorb(Fetched { vaults: vec![(a, 1, vec![]), (b, 4, vec![])], alive: vec![a, b] });
        assert_eq!(cache.revisions().len(), 2);
        // `b` n'a pas bougé (pas refetché), `a` a disparu du compte.
        cache.absorb(Fetched { vaults: vec![], alive: vec![b] });
        assert_eq!(cache.revisions(), [(b, 4)].into_iter().collect());
    }
}
