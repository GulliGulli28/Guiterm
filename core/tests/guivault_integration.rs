//! Synchronisation et partage bout en bout contre un vrai serveur GuiVault.
//!
//! Demande un serveur joignable (par défaut `http://127.0.0.1:8080`, sinon
//! `GUIVAULT_TEST_URL`) en mode d'inscription `open` — c'est ce que lance
//! `docker compose up` dans le dépôt GuiVault avec `GUIVAULT_REGISTRATION=open`.
//! Sans serveur, le test s'ignore avec un message plutôt que d'échouer : même
//! politique que les tests `sshd` de ce crate.
//!
//! Les états locaux vont dans un dossier temporaire et les jetons/clés dans
//! une map en mémoire : rien ne touche le `guivault.json` ni le trousseau de
//! la machine. Les secrets d'entités (mots de passe d'hôtes) passent par le
//! coffre local, qui retombe sur sa map mémoire sans Secret Service.
use guivault_protocol::Role;
use termius_core::guivault::account::{FingerprintTrust, MemoryStore};
use termius_core::guivault::transfer::{self, Followers, Move, Place};
use termius_core::guivault::{LoginStep, Manager, browse, sharing, sync};
use termius_core::model::{Group, Host, Snippet, VaultId, Workspace};
use termius_core::vault::{self as local_vault, SecretKind};
use std::time::Duration;
use uuid::Uuid;

fn server_url() -> String {
    std::env::var("GUIVAULT_TEST_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into())
}

async fn server_available() -> bool {
    match reqwest::get(format!("{}/api/v1/health", server_url())).await {
        Ok(r) if r.status().is_success() => true,
        _ => {
            eprintln!("⚠ pas de serveur GuiVault sur {} — test ignoré", server_url());
            false
        }
    }
}

struct Device {
    manager: Manager,
    ws: Workspace,
    _dir: tempfile::TempDir,
}

impl Device {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        Device {
            manager: Manager::with(dir.path().join("guivault"), Box::new(MemoryStore::default())),
            ws: Workspace::default(),
            _dir: dir,
        }
    }

    async fn register(email: &str, pw: &str) -> Self {
        let d = Self::new();
        d.manager.register(&server_url(), email, pw, Some("test".into())).await.unwrap();
        d
    }

    async fn login(email: &str, pw: &str) -> Self {
        let d = Self::new();
        match d.manager.login(&server_url(), email, pw, Some("test-2".into())).await.unwrap() {
            LoginStep::Connected(_) => {}
            LoginStep::TotpRequired => panic!("second facteur inattendu"),
        }
        d
    }

    async fn sync(&mut self) -> sync::Report {
        let (changes, report) = sync::run(&self.manager, &self.ws).await.unwrap();
        sync::apply_changes(&mut self.ws, changes);
        report
    }

    fn host_mut(&mut self, id: Uuid) -> &mut Host {
        self.ws.hosts.iter_mut().find(|h| h.id == id).unwrap()
    }
}

#[tokio::test]
async fn personal_vault_syncs_between_two_devices() {
    if !server_available().await {
        return;
    }
    let email = format!("alice-{}@test.local", Uuid::new_v4().simple());
    let mut a1 = Device::register(&email, "alice-master").await;
    assert!(a1.manager.status().unlocked);

    // Un workspace avec un groupe, un hôte (et son mot de passe), un snippet.
    let group = Group { id: Uuid::new_v4(), name: "prod".into(), parent_id: None, icon: None, color: None };
    let mut host = Host::new("db-1", "10.0.0.1", "root");
    host.group_id = Some(group.id);
    local_vault::store(host.id, SecretKind::Password, "s3cret").unwrap();
    let snippet = Snippet { id: Uuid::new_v4(), name: "disk".into(), command: "df -h".into(), tags: vec![], adaptive: false };
    a1.ws.groups.push(group.clone());
    a1.ws.hosts.push(host.clone());
    a1.ws.snippets.push(snippet.clone());

    let r = a1.sync().await;
    assert_eq!((r.pushed, r.pulled), (3, 0), "{r:?}");
    assert!(r.conflicts.is_empty() && r.warnings.is_empty(), "{r:?}");
    let r = a1.sync().await;
    assert_eq!((r.pushed, r.pulled), (0, 0), "une deuxième synchro sans changement ne fait rien : {r:?}");

    // Deuxième appareil : tout arrive, mot de passe compris.
    local_vault::delete(host.id, SecretKind::Password).unwrap();
    let mut a2 = Device::login(&email, "alice-master").await;
    let r = a2.sync().await;
    assert_eq!((r.pushed, r.pulled), (0, 3), "{r:?}");
    assert_eq!(a2.ws.hosts[0].label, "db-1");
    assert_eq!(a2.ws.hosts[0].group_id, Some(group.id));
    assert_eq!(local_vault::load(host.id, SecretKind::Password).unwrap().as_deref(), Some("s3cret"));
    assert!(a2.ws.vault_bindings.is_empty(), "le vault personnel n'est pas une affiliation");

    // Modification sur l'appareil 2 → visible sur le 1.
    a2.host_mut(host.id).label = "db-primary".into();
    let r = a2.sync().await;
    assert_eq!(r.pushed, 1, "{r:?}");
    let r = a1.sync().await;
    assert_eq!(r.pulled, 1, "{r:?}");
    assert_eq!(a1.ws.hosts[0].label, "db-primary");

    // Suppression sur le 1 → tombale → retrait sur le 2.
    a1.ws.snippets.clear();
    let r = a1.sync().await;
    assert_eq!(r.deleted_remotely, 1, "{r:?}");
    let r = a2.sync().await;
    assert_eq!(r.removed_locally, 1, "{r:?}");
    assert!(a2.ws.snippets.is_empty());

    // Conflit : les deux appareils modifient le même hôte. Le local gagne
    // sur celui qui synchronise en second, et le rapport le dit.
    a1.host_mut(host.id).label = "from-1".into();
    a2.host_mut(host.id).label = "from-2".into();
    a2.sync().await;
    let r = a1.sync().await;
    assert_eq!(r.conflicts.len(), 1, "{r:?}");
    assert_eq!(a1.ws.hosts[0].label, "from-1");
    let r = a2.sync().await;
    assert_eq!(r.pulled, 1, "{r:?}");
    assert_eq!(a2.ws.hosts[0].label, "from-1");

    // Mauvais mot de passe : refusé proprement.
    let d = Device::new();
    let err = d.manager.login(&server_url(), &email, "wrong", None).await.unwrap_err();
    assert!(err.to_string().contains("incorrect"), "{err}");
}

/// Un secret rangé par l'interface web de GuiVault (identifiant, note,
/// carte, identité) traverse la synchro sans bruit — et surtout sans être
/// effacé : ce client ne le stocke pas encore, il ne doit donc jamais le
/// prendre pour une suppression locale.
#[tokio::test]
async fn web_secrets_are_left_alone_by_sync() {
    if !server_available().await {
        return;
    }
    let email = format!("alice-{}@test.local", Uuid::new_v4().simple());
    let mut a1 = Device::register(&email, "alice-master").await;
    a1.ws.hosts.push(Host::new("db-1", "10.0.0.1", "root"));
    a1.sync().await;

    // Ce que l'interface web écrit : un `login` chiffré sous la clé du vault.
    let client = a1.manager.client().unwrap();
    let vault = a1.manager.vault_infos().into_iter().next().unwrap();
    let login = guivault_items::SecretItem::Login {
        login: guivault_items::Login {
            base: guivault_items::SecretBase {
                id: Uuid::new_v4(),
                name: "GitHub".into(),
                group_id: None,
                tags: vec![],
                favorite: Some(true),
                notes: None,
                fields: None,
                extra: Default::default(),
            },
            username: "alice".into(),
            password: "pw".into(),
            uris: vec![],
            totp: Some("JBSWY3DPEHPK3PXP".into()),
            passkeys: vec![],
            password_history: vec![],
        },
    };
    let json = login.to_json().unwrap();
    let ct = guivault_crypto::seal_item(&vault.key, &vault.id.to_string(), &login.id().to_string(), login.item_type(), json.as_bytes()).unwrap();
    client
        .put_item(vault.id, login.id(), &guivault_protocol::PutItemRequest { item_type: login.item_type().into(), ciphertext: ct, base_revision: None })
        .await
        .unwrap();

    // Deux synchros : rien de reçu, rien d'envoyé, rien à dire, et l'item
    // est toujours là (une troisième serait celle qui le supprimerait si
    // l'état s'en souvenait).
    for _ in 0..3 {
        let r = a1.sync().await;
        assert_eq!((r.pulled, r.pushed, r.deleted_remotely), (0, 0, 0), "{r:?}");
        assert!(r.warnings.is_empty() && r.conflicts.is_empty(), "{r:?}");
    }
    let page = client.items(vault.id, None).await.unwrap();
    let remote = page.items.iter().find(|i| i.id == login.id()).expect("le secret est toujours sur le serveur");
    assert!(!remote.deleted);
    assert_eq!(a1.ws.hosts.len(), 1, "l'hôte, lui, est synchronisé normalement");

    // Le panneau « Coller depuis GuiVault », lui, le voit — à côté de l'hôte,
    // sans en exposer la valeur avant qu'on la demande.
    let mut cache = browse::Cache::default();
    let fetched = browse::fetch(&a1.manager, &cache.revisions()).await.unwrap();
    cache.absorb(fetched);
    let entries = browse::list(&a1.manager, &cache).unwrap();
    let seen = entries.iter().find(|e| e.id == login.id()).expect("le login est listé");
    assert_eq!((seen.kind.as_str(), seen.name.as_str(), seen.vault_id), ("login", "GitHub", vault.id));
    assert!(entries.iter().any(|e| e.kind == "host" && e.name == "db-1"));
    assert!(!serde_json::to_string(&entries).unwrap().contains("\"pw\""), "aucune valeur dans la liste");
    assert_eq!(browse::read_field(&a1.manager, &cache, vault.id, login.id(), "password").unwrap(), "pw");
    assert_eq!(browse::read_field(&a1.manager, &cache, vault.id, login.id(), "username").unwrap(), "alice");
    assert_eq!(browse::totp(&a1.manager, &cache, vault.id, login.id()).unwrap().code.len(), 6);
    assert!(browse::read_field(&a1.manager, &cache, vault.id, login.id(), "nope").is_err());

    // Rien fetché deux fois quand rien n'a bougé ; et la lecture n'a laissé
    // aucune trace dans la synchro — le secret survit toujours.
    let again = browse::fetch(&a1.manager, &cache.revisions()).await.unwrap();
    assert!(again.vaults.is_empty(), "révisions inchangées, rien à relire");
    let r = a1.sync().await;
    assert_eq!((r.pulled, r.pushed, r.deleted_remotely), (0, 0, 0), "{r:?}");
    let page = client.items(vault.id, None).await.unwrap();
    assert!(page.items.iter().any(|i| i.id == login.id() && !i.deleted), "toujours là après une lecture");
}

/// Les runbooks voyagent comme les snippets ; un accès AWS écrit par
/// l'interface web traverse la synchro sans bruit mais se lit dans le
/// panneau de consultation, avec sa `~/.aws/config` prête.
#[tokio::test]
async fn runbooks_sync_and_web_aws_access_is_browsed() {
    if !server_available().await {
        return;
    }
    let email = format!("alice-{}@test.local", Uuid::new_v4().simple());
    let mut a1 = Device::register(&email, "alice-master").await;
    let runbook: termius_core::model::Runbook = serde_json::from_str(
        r#"{"id":"6f1d5b3e-0d5c-4c39-9f4e-1f0a2b3c4d5e","name":"Mise à jour","description":"web",
        "steps":[{"id":"7f1d5b3e-0d5c-4c39-9f4e-1f0a2b3c4d5e","title":"apt","notes":"",
        "action":{"kind":"command","command":"apt-get update"},"scope":{"tags":[],"groups":[]},
        "onFailure":"stop","approval":"beforeIrreversible"}]}"#,
    )
    .unwrap();
    a1.ws.runbooks.push(runbook.clone());
    let r = a1.sync().await;
    assert_eq!(r.pushed, 1, "{r:?}");

    let mut a2 = Device::login(&email, "alice-master").await;
    let r = a2.sync().await;
    assert_eq!(r.pulled, 1, "{r:?}");
    assert_eq!(a2.ws.runbooks[0].name, "Mise à jour");
    assert_eq!(a2.ws.runbooks[0].steps.len(), 1);

    // Un accès AWS tel que l'interface web l'écrit.
    let client = a1.manager.client().unwrap();
    let vault = a1.manager.vault_infos().into_iter().next().unwrap();
    let id = Uuid::new_v4();
    let json = format!(
        r#"{{"kind":"aws","aws":{{"id":"{id}","name":"Org","groupId":null,"tags":[],"authType":"sso","ssoSessionName":"org",
        "ssoStartUrl":"https://org.awsapps.com/start","ssoRegion":"eu-west-1","accessKeyId":"","secretAccessKey":"","mfaSerial":"",
        "region":"eu-west-3","profiles":[{{"name":"prod","accountId":"123456789012","roleName":"Admin","region":""}}]}}}}"#
    );
    let ct = guivault_crypto::seal_item(&vault.key, &vault.id.to_string(), &id.to_string(), "aws", json.as_bytes()).unwrap();
    client
        .put_item(vault.id, id, &guivault_protocol::PutItemRequest { item_type: "aws".into(), ciphertext: ct, base_revision: None })
        .await
        .unwrap();
    for _ in 0..2 {
        let r = a1.sync().await;
        assert!(r.warnings.is_empty() && r.pulled == 0 && r.deleted_remotely == 0, "{r:?}");
    }
    let mut cache = browse::Cache::default();
    cache.absorb(browse::fetch(&a1.manager, &cache.revisions()).await.unwrap());
    let entries = browse::list(&a1.manager, &cache).unwrap();
    assert!(entries.iter().any(|e| e.kind == "runbook" && e.name == "Mise à jour"));
    let aws = entries.iter().find(|e| e.id == id).expect("l'accès AWS est listé");
    assert_eq!(aws.kind, "aws");
    let config = browse::read_field(&a1.manager, &cache, vault.id, id, "awsConfig").unwrap();
    assert!(config.contains("[profile prod]") && config.contains("sso_account_id = 123456789012"), "{config}");
    let access = browse::aws_access(&a1.manager, &cache, vault.id, id).unwrap();
    assert_eq!(access.profiles[0].role_name, "Admin");
}

#[tokio::test]
async fn shared_vault_with_fingerprint_gate_roles_and_rotation() {
    if !server_available().await {
        return;
    }
    let tag = Uuid::new_v4().simple();
    let alice_email = format!("alice-{tag}@test.local");
    let bob_email = format!("bob-{tag}@test.local");
    let mut alice = Device::register(&alice_email, "pw-a").await;
    let mut bob = Device::register(&bob_email, "pw-b").await;
    alice.sync().await;
    bob.sync().await;

    let team = sharing::create_vault(&alice.manager, "Équipe infra").await.unwrap();
    assert_eq!(team.role, Role::Owner);
    assert!(alice.manager.status().vaults.iter().any(|v| v.id == team.id && v.name == "Équipe infra"));

    // Pas d'empreinte épinglée → pas de partage.
    let lookup = sharing::lookup_user(&alice.manager, &bob_email).await.unwrap().expect("Bob existe");
    assert_eq!(lookup.trust, FingerprintTrust::Unknown);
    let err = sharing::invite(&alice.manager, team.id, &bob_email, Role::Reader).await.unwrap_err();
    assert!(err.to_string().contains("empreinte"), "{err}");
    assert_eq!(lookup.fingerprint, bob.manager.status().fingerprint.unwrap(), "l'empreinte vue par Alice est celle de Bob");
    alice.manager.pin_fingerprint(&bob_email, &lookup.fingerprint).unwrap();
    let inv = sharing::invite(&alice.manager, team.id, &bob_email, Role::Reader).await.unwrap();
    assert!(inv.has_key);

    // Bob accepte, voit le vault.
    let mine = sharing::my_invitations(&bob.manager).await.unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].inviter_email, alice_email);
    sharing::accept_invitation(&bob.manager, mine[0].id).await.unwrap();
    assert!(bob.manager.status().vaults.iter().any(|v| v.id == team.id && v.name == "Équipe infra" && v.role == Role::Reader));

    // Alice range un hôte dans le vault partagé → Bob le reçoit, lié au vault.
    let host = Host::new("bastion", "bastion.internal", "ops");
    local_vault::store(host.id, SecretKind::Password, "ops-pw").unwrap();
    alice.ws.hosts.push(host.clone());
    let r = alice.sync().await;
    assert_eq!(r.pushed, 1);
    alice.ws.vault_bindings.insert(host.id, team.id);
    let r = alice.sync().await;
    assert_eq!(r.pushed, 1, "déplacé vers le vault partagé : {r:?}");
    local_vault::delete(host.id, SecretKind::Password).unwrap();
    let r = bob.sync().await;
    assert_eq!(r.pulled, 1, "{r:?}");
    assert_eq!(bob.ws.hosts[0].label, "bastion");
    assert_eq!(bob.ws.vault_bindings.get(&host.id), Some(&team.id));
    assert_eq!(local_vault::load(host.id, SecretKind::Password).unwrap().as_deref(), Some("ops-pw"));

    // Lecteur : sa modification n'est pas envoyée, et le rapport le dit.
    bob.host_mut(host.id).label = "bastion-bob".into();
    let r = bob.sync().await;
    assert_eq!(r.pushed, 0);
    assert!(r.warnings.iter().any(|w| w.contains("lecture seule")), "{r:?}");
    // Promu writer : ça part.
    let bob_id = bob.manager.status().user_id.unwrap();
    sharing::update_member(&alice.manager, team.id, bob_id, Role::Writer).await.unwrap();
    let r = bob.sync().await;
    assert_eq!(r.pushed, 1, "{r:?}");
    let r = alice.sync().await;
    assert_eq!(r.pulled, 1, "{r:?}");
    assert_eq!(alice.ws.hosts.len(), 1, "rapport {r:?} ; bindings {:?} ; vaults {:?}", alice.ws.vault_bindings, alice.manager.status().vaults);
    assert_eq!(alice.ws.hosts[0].label, "bastion-bob");

    let members = sharing::members(&alice.manager, team.id).await.unwrap();
    assert_eq!(members.len(), 2);
    assert!(members.iter().any(|m| m.email == bob_email && m.trust == FingerprintTrust::Pinned && m.role == Role::Writer));

    // Retrait de Bob + rotation : Bob perd l'hôte, Alice relit tout avec la
    // nouvelle clé sans rien re-pousser.
    sharing::remove_member(&alice.manager, team.id, bob_id, true).await.unwrap();
    let r = alice.sync().await;
    assert_eq!((r.pushed, r.pulled), (0, 0), "relu sous la nouvelle clé, identique, rien à faire : {r:?}");
    assert!(r.conflicts.is_empty(), "{r:?}");
    assert_eq!(alice.ws.hosts[0].label, "bastion-bob");
    // (Bob après Alice : dans ce test les « appareils » partagent le coffre
    // local mémoire du processus, et le retrait chez Bob efface le mot de
    // passe de l'hôte — qu'Alice aurait sinon vu comme une modification.)
    let r = bob.sync().await;
    assert_eq!(r.removed_locally, 1, "{r:?}");
    assert!(bob.ws.hosts.is_empty());
    assert!(!bob.manager.status().vaults.iter().any(|v| v.id == team.id));

    // Invitation différée : Carol n'existe pas encore.
    let carol_email = format!("carol-{tag}@test.local");
    let inv = sharing::invite(&alice.manager, team.id, &carol_email, Role::Writer).await.unwrap();
    assert!(!inv.has_key);
    let mut carol = Device::register(&carol_email, "pw-c").await;
    let mine = sharing::my_invitations(&carol.manager).await.unwrap();
    let accepted = sharing::accept_invitation(&carol.manager, mine[0].id).await.unwrap();
    assert_eq!(accepted.status, guivault_protocol::InvitationStatus::AwaitingKey);
    // Alice voit maintenant l'empreinte de Carol sur l'invitation, l'épingle, complète.
    let pending = sharing::vault_invitations(&alice.manager, team.id).await.unwrap();
    let p = pending.iter().find(|i| i.id == inv.id).unwrap();
    assert_eq!(p.invitee_trust, Some(FingerprintTrust::Unknown));
    let err = sharing::complete_invitation(&alice.manager, team.id, inv.id).await.unwrap_err();
    assert!(err.to_string().contains("empreinte"));
    alice.manager.pin_fingerprint(&carol_email, p.invitee_fingerprint.as_deref().unwrap()).unwrap();
    let done = sharing::complete_invitation(&alice.manager, team.id, inv.id).await.unwrap();
    assert_eq!(done.status, guivault_protocol::InvitationStatus::Accepted);
    let r = carol.sync().await;
    assert_eq!(r.pulled, 1, "{r:?}");
    assert_eq!(carol.ws.hosts[0].label, "bastion-bob");

    // Une empreinte qui change est une alerte, pas un détail.
    alice.manager.pin_fingerprint(&carol_email, "0000-0000-0000-0000-0000-0000-0000-0000").unwrap();
    let lookup = sharing::lookup_user(&alice.manager, &carol_email).await.unwrap().unwrap();
    assert!(matches!(lookup.trust, FingerprintTrust::Changed { .. }));

    // Déconnexion d'Alice : plus de compte actif, mais il reste connu (le
    // panneau le propose) ; l'oublier l'efface de la liste et de la machine.
    let alice_id = alice.manager.status().user_id.unwrap();
    alice.manager.logout().await.unwrap();
    let st = alice.manager.status();
    assert!(!st.configured);
    assert!(st.accounts.iter().any(|a| a.user_id == alice_id && a.email == alice_email));
    alice.manager.forget(alice_id).await.unwrap();
    assert!(alice.manager.status().accounts.is_empty());
    assert!(!alice.manager.workspace_path(alice_id).exists());
}

/// Le scénario rapporté le 2026-09-15 (deux comptes sur le même PC qui
/// partageaient alors un seul workspace) : Alice range un hôte dans un vault
/// partagé ; Bob se retrouve avec le même hôte « personnel », le pousse dans
/// SON vault personnel, puis accepte l'invitation au vault partagé. L'hôte
/// doit finir dans le vault partagé, et la copie personnelle de Bob
/// disparaître — pas l'inverse.
#[tokio::test]
async fn same_machine_account_switch_keeps_shared_entity_in_shared_vault() {
    if !server_available().await {
        return;
    }
    let tag = Uuid::new_v4().simple();
    let (alice_email, bob_email) = (format!("alice-{tag}@test.local"), format!("bob-{tag}@test.local"));
    let mut alice = Device::register(&alice_email, "pw-a").await;
    let bob_reg = Device::register(&bob_email, "pw-b").await;
    let team = sharing::create_vault(&alice.manager, "testing").await.unwrap();
    let host = Host::new("srv", "10.0.0.1", "root");
    alice.ws.hosts.push(host.clone());
    alice.ws.vault_bindings.insert(host.id, team.id);
    assert_eq!(alice.sync().await.pushed, 1);
    let lookup = sharing::lookup_user(&alice.manager, &bob_email).await.unwrap().unwrap();
    alice.manager.pin_fingerprint(&bob_email, &lookup.fingerprint).unwrap();
    sharing::invite(&alice.manager, team.id, &bob_email, Role::Reader).await.unwrap();

    // Avec un workspace par compte ce scénario n'arrive plus par l'app —
    // mais le moteur doit rester correct si un hôte identique se retrouve
    // « personnel » sur un appareil (import, restauration d'une sauvegarde…).
    let mut bob = Device::new();
    bob.manager.login(&server_url(), &bob_email, "pw-b", None).await.unwrap();
    bob.ws = alice.ws.clone();
    bob.ws.vault_bindings.clear();
    let r = bob.sync().await;
    assert_eq!(r.pushed, 1, "{r:?}");

    // Il accepte l'invitation : l'hôte rejoint « testing » et sa copie
    // personnelle en face est supprimée.
    let mine = sharing::my_invitations(&bob.manager).await.unwrap();
    sharing::accept_invitation(&bob.manager, mine[0].id).await.unwrap();
    let r = bob.sync().await;
    assert_eq!(bob.ws.vault_bindings.get(&host.id), Some(&team.id), "{r:?}");
    assert_eq!(r.deleted_remotely, 1, "{r:?}");
    assert_eq!(bob.ws.hosts.len(), 1);
    let personal = bob.manager.status().vaults.iter().find(|v| v.kind == guivault_protocol::VaultKind::Personal).unwrap().id;
    let page = bob.manager.client().unwrap().items(personal, None).await.unwrap();
    assert!(page.items.is_empty(), "plus de copie personnelle : {:?}", page.items.len());
    // Stable : une synchro de plus ne change rien.
    let r = bob.sync().await;
    assert_eq!((r.pushed, r.pulled, r.deleted_remotely), (0, 0, 0), "{r:?}");
    assert_eq!(bob.ws.vault_bindings.get(&host.id), Some(&team.id));
    drop(bob_reg);
}

/// Ce que le menu des vaults fait (« Déplacer vers », « Copier vers »,
/// « Ajouter… »), joué avec le vrai moteur de bout en bout : la sélection
/// passe par `transfer::apply` (comme la commande Tauri), puis la synchro
/// pousse le résultat et l'autre membre le reçoit. Chaque sens est vérifié
/// une fois contre le serveur, y compris le refus en lecture seule.
#[tokio::test]
async fn moving_and_copying_between_places_reaches_the_other_member() {
    if !server_available().await {
        return;
    }
    let tag = Uuid::new_v4().simple();
    let (alice_email, bob_email) = (format!("alice-{tag}@test.local"), format!("bob-{tag}@test.local"));
    let mut alice = Device::register(&alice_email, "pw-a").await;
    let mut bob = Device::register(&bob_email, "pw-b").await;
    alice.sync().await;
    bob.sync().await;
    let team = sharing::create_vault(&alice.manager, "infra").await.unwrap();
    let lookup = sharing::lookup_user(&alice.manager, &bob_email).await.unwrap().unwrap();
    alice.manager.pin_fingerprint(&bob_email, &lookup.fingerprint).unwrap();
    sharing::invite(&alice.manager, team.id, &bob_email, Role::Reader).await.unwrap();
    let mine = sharing::my_invitations(&bob.manager).await.unwrap();
    sharing::accept_invitation(&bob.manager, mine[0].id).await.unwrap();

    let can_write = |m: &Manager| {
        let vaults = m.status().vaults;
        move |v: VaultId| vaults.iter().any(|x| x.id == v && x.role.can_write_items())
    };

    // Le profil local d'Alice : un dossier avec un hôte (et son mot de passe).
    let mut local = Workspace::default();
    let folder = Group { id: Uuid::new_v4(), name: "Prod".into(), parent_id: None, icon: None, color: None };
    let mut host = Host::new("db-1", "10.0.0.1", "root");
    host.group_id = Some(folder.id);
    local_vault::store(host.id, SecretKind::Password, "s3cret").unwrap();
    local.groups.push(folder.clone());
    local.hosts.push(host.clone());

    // « Ajouter… » depuis cet appareil, en déplaçant : l'hôte et son dossier
    // partent dans le vault partagé, et Bob les reçoit avec le secret.
    let n = transfer::apply(&mut local, &mut alice.ws, Move { ids: &[host.id], from: Place::Local, to: Place::Account { vault_id: Some(team.id) }, copy: false, followers: Followers::Quiet }, can_write(&alice.manager)).unwrap();
    assert_eq!(n, 2);
    assert!(local.hosts.is_empty() && local.groups.is_empty());
    let r = alice.sync().await;
    assert_eq!(r.pushed, 2, "{r:?}");
    local_vault::delete(host.id, SecretKind::Password).unwrap();
    let r = bob.sync().await;
    assert_eq!(r.pulled, 2, "{r:?}");
    assert_eq!(bob.ws.hosts[0].group_id, Some(folder.id), "le dossier est arrivé avec l'hôte");
    assert_eq!(bob.ws.vault_bindings.get(&folder.id), Some(&team.id));
    assert_eq!(local_vault::load(host.id, SecretKind::Password).unwrap().as_deref(), Some("s3cret"));

    // Bob, lecteur : ne peut ni retirer vers son appareil ni déplacer vers
    // son personnel — mais peut copier chez lui, sous un nouvel id, sans
    // rien changer sur le serveur.
    let mut bob_local = Workspace::default();
    let err = transfer::apply(&mut bob_local, &mut bob.ws, Move { ids: &[host.id], from: Place::Account { vault_id: Some(team.id) }, to: Place::Local, copy: false, followers: Followers::Quiet }, can_write(&bob.manager)).unwrap_err();
    assert!(err.to_string().contains("lecture seule"), "{err}");
    let err = transfer::apply(&mut bob_local, &mut bob.ws, Move { ids: &[host.id], from: Place::Account { vault_id: Some(team.id) }, to: Place::Account { vault_id: None }, copy: false, followers: Followers::Quiet }, can_write(&bob.manager)).unwrap_err();
    assert!(err.to_string().contains("lecture seule"), "{err}");
    let n = transfer::apply(&mut bob_local, &mut bob.ws, Move { ids: &[host.id], from: Place::Account { vault_id: Some(team.id) }, to: Place::Local, copy: true, followers: Followers::Quiet }, can_write(&bob.manager)).unwrap();
    assert_eq!(n, 2);
    let copy = bob_local.hosts.iter().find(|h| h.label == "db-1").unwrap();
    assert_ne!(copy.id, host.id);
    assert_eq!(local_vault::load(copy.id, SecretKind::Password).unwrap().as_deref(), Some("s3cret"), "le secret est dupliqué sous le nouvel id");
    let r = bob.sync().await;
    assert_eq!((r.pushed, r.pulled, r.deleted_remotely), (0, 0, 0), "une copie vers l'appareil ne touche pas au compte : {r:?}");

    // Alice copie l'hôte dans son vault personnel : un deuxième exemplaire,
    // poussé sous un nouvel id ; l'original reste partagé, Bob ne voit rien.
    let n = transfer::apply(&mut local, &mut alice.ws, Move { ids: &[host.id], from: Place::Account { vault_id: Some(team.id) }, to: Place::Account { vault_id: None }, copy: true, followers: Followers::Quiet }, can_write(&alice.manager)).unwrap();
    assert_eq!(n, 2);
    assert_eq!(alice.ws.hosts.len(), 2);
    let r = alice.sync().await;
    assert_eq!(r.pushed, 2, "{r:?}");
    let r = bob.sync().await;
    assert_eq!((r.pulled, r.removed_locally), (0, 0), "{r:?}");

    // Puis retire l'original vers son appareil : tombale côté serveur, Bob
    // perd l'hôte et le dossier.
    let n = transfer::apply(&mut local, &mut alice.ws, Move { ids: &[host.id], from: Place::Account { vault_id: Some(team.id) }, to: Place::Local, copy: false, followers: Followers::Quiet }, can_write(&alice.manager)).unwrap();
    assert_eq!(n, 2);
    assert_eq!(local.hosts[0].id, host.id, "déplacé, même id");
    let r = alice.sync().await;
    assert_eq!(r.deleted_remotely, 2, "{r:?}");
    let r = bob.sync().await;
    assert_eq!(r.removed_locally, 2, "{r:?}");
    assert!(bob.ws.hosts.is_empty() && bob.ws.groups.is_empty());
    // L'exemplaire personnel d'Alice est toujours là, et stable.
    assert_eq!(alice.ws.hosts.len(), 1);
    assert!(alice.ws.vault_bindings.is_empty());
    let r = alice.sync().await;
    assert_eq!((r.pushed, r.pulled, r.deleted_remotely), (0, 0, 0), "{r:?}");
}

/// Le bug du 2026-09-18, joué contre le serveur : copier un sous-dossier
/// dans un vault partagé y copiait aussi les autres dossiers de son parent.
/// Bob ne doit recevoir que le sous-dossier, son contenu et la chaîne de
/// dossiers qui y mène — pas les frères.
#[tokio::test]
async fn copying_a_subfolder_to_a_shared_vault_sends_no_sibling() {
    if !server_available().await {
        return;
    }
    let tag = Uuid::new_v4().simple();
    let (alice_email, bob_email) = (format!("alice-{tag}@test.local"), format!("bob-{tag}@test.local"));
    let mut alice = Device::register(&alice_email, "pw-a").await;
    let mut bob = Device::register(&bob_email, "pw-b").await;
    let team = sharing::create_vault(&alice.manager, "infra").await.unwrap();
    let lookup = sharing::lookup_user(&alice.manager, &bob_email).await.unwrap().unwrap();
    alice.manager.pin_fingerprint(&bob_email, &lookup.fingerprint).unwrap();
    sharing::invite(&alice.manager, team.id, &bob_email, Role::Writer).await.unwrap();
    let mine = sharing::my_invitations(&bob.manager).await.unwrap();
    sharing::accept_invitation(&bob.manager, mine[0].id).await.unwrap();

    // Prod/ { Bases/ { pg }, Web/ { web }, loose } — personnel d'Alice.
    let parent = Group { id: Uuid::new_v4(), name: "Prod".into(), parent_id: None, icon: None, color: None };
    let sub = Group { id: Uuid::new_v4(), name: "Bases".into(), parent_id: Some(parent.id), icon: None, color: None };
    let sibling = Group { id: Uuid::new_v4(), name: "Web".into(), parent_id: Some(parent.id), icon: None, color: None };
    let mut pg = Host::new("pg", "10.0.0.1", "root");
    pg.group_id = Some(sub.id);
    let mut web = Host::new("web", "10.0.0.2", "root");
    web.group_id = Some(sibling.id);
    let mut loose = Host::new("loose", "10.0.0.3", "root");
    loose.group_id = Some(parent.id);
    alice.ws.groups.extend([parent.clone(), sub.clone(), sibling.clone()]);
    alice.ws.hosts.extend([pg.clone(), web.clone(), loose.clone()]);
    assert_eq!(alice.sync().await.pushed, 6);

    // Le panneau : la case du dossier « Bases » (lui et son sous-arbre), le
    // plan, rien de décoché, copier vers « infra ».
    let checked = [sub.id, pg.id];
    let plan = transfer::plan(&alice.ws, &checked);
    assert!(plan.followers.iter().all(|f| f.entity.id != sibling.id && f.entity.id != web.id && f.entity.id != loose.id));
    let mut local = Workspace::default();
    let n = transfer::apply(&mut local, &mut alice.ws, Move { ids: &checked, from: Place::Account { vault_id: None }, to: Place::Account { vault_id: Some(team.id) }, copy: true, followers: Followers::Chosen { dropped: &[] } }, can_write_in(&alice.manager)).unwrap();
    assert_eq!(n, 3, "Bases, pg, Prod (en chaîne)");
    let r = alice.sync().await;
    assert_eq!(r.pushed, 3, "{r:?}");

    let r = bob.sync().await;
    assert_eq!(r.pulled, 3, "{r:?}");
    let names: Vec<&str> = bob.ws.groups.iter().map(|g| g.name.as_str()).collect();
    assert!(names.contains(&"Prod") && names.contains(&"Bases") && !names.contains(&"Web"), "{names:?}");
    assert_eq!(bob.ws.hosts.len(), 1, "seul pg : {:?}", bob.ws.hosts.iter().map(|h| &h.label).collect::<Vec<_>>());
    assert_eq!(bob.ws.hosts[0].label, "pg");
    // Et la copie est rangée à sa place : Bases sous Prod, pg dans Bases.
    let bases = bob.ws.groups.iter().find(|g| g.name == "Bases").unwrap();
    let prod = bob.ws.groups.iter().find(|g| g.name == "Prod").unwrap();
    assert_eq!(bases.parent_id, Some(prod.id));
    assert_eq!(bob.ws.hosts[0].group_id, Some(bases.id));
    // Les originaux d'Alice sont intacts et toujours personnels.
    assert_eq!(alice.ws.hosts.len(), 4);
    assert!(alice.ws.hosts.iter().filter(|h| h.id == pg.id || h.id == web.id || h.id == loose.id).all(|h| !alice.ws.vault_bindings.contains_key(&h.id)));
}

fn can_write_in(m: &Manager) -> impl Fn(VaultId) -> bool {
    let vaults = m.status().vaults;
    move |v: VaultId| vaults.iter().any(|x| x.id == v && x.role.can_write_items())
}

#[tokio::test]
async fn totp_login_in_two_steps_and_live_events() {
    use futures_util::StreamExt;
    if !server_available().await {
        return;
    }
    let tag = Uuid::new_v4().simple();
    let email = format!("alice-{tag}@test.local");
    let alice = Device::register(&email, "pw-a").await;
    assert!(!alice.manager.totp_status().await.unwrap());

    // Enrôlement : le code vient d'une app d'authentification — ici totp-rs
    // à partir du secret base32, exactement ce que ferait l'app.
    let setup = alice.manager.totp_setup().await.unwrap();
    let totp = totp_rs::TOTP::new(
        totp_rs::Algorithm::SHA1, 6, 1, 30,
        totp_rs::Secret::Encoded(setup.secret).to_bytes().unwrap(),
        Some("GuiVault".into()), email.clone(),
    ).unwrap();
    assert!(alice.manager.totp_enable("000000").await.is_err());
    let recovery = alice.manager.totp_enable(&totp.generate_current().unwrap()).await.unwrap();
    assert_eq!(recovery.len(), 8);
    assert!(alice.manager.totp_status().await.unwrap());

    // Nouvel appareil : mot de passe, puis code. Un mauvais code n'oblige
    // pas à retaper le mot de passe.
    let mut d = Device::new();
    let step = d.manager.login(&server_url(), &email, "pw-a", None).await.unwrap();
    assert!(matches!(step, LoginStep::TotpRequired));
    assert!(!d.manager.status().configured);
    let err = d.manager.login_totp("123456").await.unwrap_err();
    assert!(err.to_string().contains("incorrect"), "{err}");
    let status = d.manager.login_totp(&totp.generate_current().unwrap()).await.unwrap();
    assert!(status.unlocked);
    d.sync().await;
    // Un code de récupération marche aussi (une fois).
    let d2 = Device::new();
    d2.manager.login(&server_url(), &email, "pw-a", None).await.unwrap();
    d2.manager.login_totp(&recovery[0]).await.unwrap();
    let d3 = Device::new();
    d3.manager.login(&server_url(), &email, "pw-a", None).await.unwrap();
    assert!(d3.manager.login_totp(&recovery[0]).await.is_err());

    // Événements : l'appareil 1 (session révoquée à l'activation du 2FA,
    // donc on prend `d`) écoute, Alice écrit depuis `d2`.
    let client = d.manager.client().unwrap();
    let mut events = client.events().await.unwrap();
    let mut writer = Device::new();
    writer.manager.login(&server_url(), &email, "pw-a", None).await.unwrap();
    writer.manager.login_totp(&totp.generate_current().unwrap()).await.unwrap();
    writer.ws.hosts.push(Host::new("evt", "10.0.0.9", "root"));
    let r = writer.sync().await;
    assert_eq!(r.pushed, 1, "{r:?}");
    let personal = d.manager.status().vaults[0].id;
    let ev = tokio::time::timeout(Duration::from_secs(10), events.next()).await.expect("événement attendu").unwrap();
    assert!(matches!(ev, guivault_protocol::ServerEvent::VaultChanged { vault_id, .. } if vault_id == personal), "{ev:?}");

    // Désactivation : la connexion redevient en un temps.
    alice.manager.totp_disable(&totp.generate_current().unwrap()).await.unwrap_or_else(|e| {
        // La session d'`alice` a été révoquée par l'activation ; `d` la remplace.
        eprintln!("session initiale révoquée ({e}) — désactivation depuis l'appareil 2");
    });
    if d.manager.totp_status().await.unwrap() {
        d.manager.totp_disable(&totp.generate_current().unwrap()).await.unwrap();
    }
    let d4 = Device::new();
    assert!(matches!(d4.manager.login(&server_url(), &email, "pw-a", None).await.unwrap(), LoginStep::Connected(_)));
}

#[tokio::test]
async fn kdf_params_are_pinned_and_a_downgrade_is_refused() {
    if !server_available().await {
        return;
    }
    let default = guivault_crypto::KdfParams::default();
    let email = format!("kdf-{}@test.local", Uuid::new_v4().simple());
    let d = Device::register(&email, "kdf-master").await;
    // L'inscription épingle les paramètres du compte, dans le registre.
    assert_eq!(d.manager.pinned_kdf(&server_url(), &email), Some(default));
    assert_eq!(d.manager.status().accounts[0].kdf, Some(default));

    // La dernière connexion d'ici avait plus de mémoire que ce que le serveur
    // annonce maintenant : c'est ce que ferait un serveur compromis qui
    // abaisse les paramètres pour casser la clé d'auth. Refus avant de
    // dériver — e-mail en majuscules : la comparaison ignore la casse.
    d.manager.logout().await.unwrap();
    let path = d._dir.path().join("guivault/accounts.json");
    let mut reg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    reg["accounts"][0]["kdf"]["m_cost"] = serde_json::json!(default.m_cost * 2);
    std::fs::write(&path, reg.to_string()).unwrap();
    d.manager.restore().unwrap();
    let err = match d.manager.login(&server_url(), &email.to_uppercase(), "kdf-master", None).await {
        Ok(_) => panic!("connexion acceptée malgré des paramètres plus faibles que ceux épinglés"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("plus faible"), "{err}");
    assert!(!d.manager.status().configured, "aucune session ne doit s'ouvrir");

    // Sur une autre machine (rien d'épinglé), la connexion passe et épingle ;
    // le changement de mot de passe vérifie puis ré-épingle.
    let d2 = Device::login(&email, "kdf-master").await;
    assert_eq!(d2.manager.pinned_kdf(&server_url(), &email), Some(default));
    d2.manager.change_password("kdf-master", "kdf-master-2").await.unwrap();
    assert_eq!(d2.manager.pinned_kdf(&server_url(), &email), Some(default));
}

#[tokio::test]
async fn vault_rollback_suspends_sync_until_resumed() {
    if !server_available().await {
        return;
    }
    let email = format!("rollback-{}@test.local", Uuid::new_v4().simple());
    let mut a1 = Device::register(&email, "rollback-master").await;
    let host = Host::new("web-1", "10.0.0.2", "deploy");
    let doomed = Host::new("old-1", "10.0.0.3", "root");
    let snippet = Snippet { id: Uuid::new_v4(), name: "uptime".into(), command: "uptime".into(), tags: vec![], adaptive: false };
    a1.ws.hosts.extend([host.clone(), doomed.clone()]);
    a1.ws.snippets.push(snippet.clone());
    assert_eq!(a1.sync().await.pushed, 3);
    // Les vaults ne sont connus qu'après une première synchro.
    let personal = a1.manager.status().vaults.iter().find(|v| v.kind == guivault_protocol::VaultKind::Personal).unwrap().id;

    // Un autre appareil fait diverger le serveur : une autre version de
    // l'hôte, le snippet supprimé (ce que le serveur « aura perdu »).
    let mut a2 = Device::login(&email, "rollback-master").await;
    a2.sync().await;
    a2.host_mut(host.id).label = "version-du-serveur".into();
    a2.ws.snippets.clear();
    let r = a2.sync().await;
    assert_eq!((r.pushed, r.deleted_remotely), (1, 1), "{r:?}");

    // a1 croit avoir vu une révision plus haute (de 2) que celle du serveur :
    // pour lui, la base a été restaurée (ou le serveur ment). La révision
    // courante : celle que a2 lit en tête d'une synchro sans changement.
    a2.sync().await;
    let server_rev = a2.manager.status().vaults.iter().find(|v| v.id == personal).unwrap().revision;
    a1.manager.update_state(|s| {
        s.sync.vault_revisions.insert(personal, server_rev + 2);
    }).unwrap();
    a1.ws.snippets.push(Snippet { id: Uuid::new_v4(), name: "df".into(), command: "df -h".into(), tags: vec![], adaptive: false });
    a1.ws.hosts.retain(|h| h.id != doomed.id);
    let r = a1.sync().await;
    assert!(r.warnings.iter().any(|w| w.contains("revenu en arrière")), "{r:?}");
    // Suspendu : rien reçu (l'hôte garde sa version d'ici), rien envoyé,
    // rien supprimé.
    assert_eq!((r.pulled, r.pushed, r.deleted_remotely), (0, 0, 0), "{r:?}");
    assert_eq!(a1.ws.hosts.iter().find(|h| h.id == host.id).unwrap().label, "web-1");
    let rollbacks = a1.manager.status().rollbacks;
    assert_eq!(rollbacks.len(), 1);
    assert_eq!(rollbacks[0].vault_id, personal);
    // Le serveur repart de sa révision et la dépasse bientôt : sans la
    // suspension, `?since=` sauterait tout ce qui s'écrit sous des révisions
    // déjà « vues ». Toujours suspendu, sans nouvelle alerte.
    for n in 1..=3 {
        a2.ws.snippets.push(Snippet { id: Uuid::new_v4(), name: format!("a2-{n}"), command: "true".into(), tags: vec![], adaptive: false });
    }
    assert_eq!(a2.sync().await.pushed, 3);
    let r = a1.sync().await;
    assert_eq!((r.pulled, r.pushed), (0, 0), "{r:?}");
    assert!(r.warnings.is_empty(), "{r:?}");

    // Reprise : cet appareil fait foi. L'hôte y retourne dans sa version,
    // le snippet « perdu » est recréé, le nouveau envoyé, l'hôte supprimé
    // ici supprimé là-bas — sans conflit annoncé ; ce qu'il ne connaissait
    // pas (les trois de a2) est reçu.
    a1.manager.resume_after_rollback(personal).unwrap();
    let r = a1.sync().await;
    assert!(r.conflicts.is_empty() && r.warnings.is_empty(), "{r:?}");
    assert_eq!((r.pulled, r.pushed, r.deleted_remotely), (3, 3, 1), "{r:?}");
    assert!(a1.manager.status().rollbacks.is_empty());
    assert_eq!(a1.sync().await.pushed, 0, "une synchro de plus ne renvoie rien");

    // L'autre appareil reçoit la version de a1.
    a2.sync().await;
    assert_eq!(a2.ws.hosts.iter().find(|h| h.id == host.id).unwrap().label, "web-1");
    assert!(a2.ws.hosts.iter().all(|h| h.id != doomed.id));
    let mut names: Vec<_> = a2.ws.snippets.iter().map(|s| s.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["a2-1", "a2-2", "a2-3", "df", "uptime"]);
}

#[tokio::test]
async fn vault_key_provenance_is_known_and_verifiable() {
    use termius_core::guivault::KeyFrom;
    use termius_core::guivault::sharing::InvitationKey;
    if !server_available().await {
        return;
    }
    let tag = Uuid::new_v4().simple();
    let alice_email = format!("alice-{tag}@test.local");
    let bob_email = format!("bob-{tag}@test.local");
    let mut alice = Device::register(&alice_email, "pw-a").await;
    let mut bob = Device::register(&bob_email, "pw-b").await;
    alice.sync().await;
    bob.sync().await;
    let alice_fp = alice.manager.status().fingerprint.unwrap();
    let key_from = |d: &Device, id| d.manager.status().vaults.into_iter().find(|v| v.id == id).map(|v| (v.key_from, v.key_from_pinned_as));

    // Son vault personnel et ceux qu'on crée : clé de soi.
    let personal = alice.manager.status().vaults.iter().find(|v| v.kind == guivault_protocol::VaultKind::Personal).unwrap().id;
    assert_eq!(key_from(&alice, personal).unwrap().0, KeyFrom::Own);
    let team = sharing::create_vault(&alice.manager, "Équipe").await.unwrap();
    assert_eq!(key_from(&alice, team.id).unwrap().0, KeyFrom::Own);

    // Bob reçoit la clé d'Alice : il sait qu'elle vient d'elle, pas encore
    // vérifiée ; épinglée, elle l'est.
    alice.manager.pin_fingerprint(&bob_email, &bob.manager.status().fingerprint.unwrap()).unwrap();
    sharing::invite(&alice.manager, team.id, &bob_email, Role::Writer).await.unwrap();
    // Avant d'accepter, l'enveloppe jointe dit qui remet la clé…
    let inv = sharing::my_invitations(&bob.manager).await.unwrap().remove(0);
    assert_eq!(
        inv.inviter_key,
        Some(InvitationKey::Member { fingerprint: alice_fp.clone(), trust: FingerprintTrust::Unknown })
    );
    // … et le signale si Bob avait vérifié une autre clé pour Alice.
    bob.manager.pin_fingerprint(&alice_email, "0000-1111-2222-3333-4444-5555-6666-7777").unwrap();
    let inv = sharing::my_invitations(&bob.manager).await.unwrap().remove(0);
    assert!(matches!(inv.inviter_key, Some(InvitationKey::Member { trust: FingerprintTrust::Changed { .. }, .. })), "{inv:?}");
    sharing::accept_invitation(&bob.manager, inv.id).await.unwrap();
    bob.sync().await;
    assert_eq!(key_from(&bob, team.id).unwrap(), (KeyFrom::Member { fingerprint: alice_fp.clone() }, None));
    bob.manager.pin_fingerprint(&alice_email, &alice_fp).unwrap();
    assert_eq!(key_from(&bob, team.id).unwrap().1.as_deref(), Some(alice_email.as_str()));

    // Alice renouvelle la clé : toujours d'elle pour Bob, et Bob lit ce
    // qu'elle y range avec la nouvelle.
    sync::rotate_vault_key(&alice.manager, team.id).await.unwrap();
    let snippet = Snippet { id: Uuid::new_v4(), name: "après rotation".into(), command: "true".into(), tags: vec![], adaptive: false };
    alice.ws.snippets.push(snippet.clone());
    alice.ws.vault_bindings.insert(snippet.id, team.id);
    alice.sync().await;
    bob.sync().await;
    assert_eq!(key_from(&bob, team.id).unwrap().0, KeyFrom::Member { fingerprint: alice_fp });
    assert!(bob.ws.snippets.iter().any(|s| s.id == snippet.id));
}

#[tokio::test]
async fn trash_and_history_follow_moves_deletions_and_rotation() {
    if !server_available().await {
        return;
    }
    let email = format!("trash-{}@test.local", Uuid::new_v4().simple());
    let mut a = Device::register(&email, "trash-master").await;
    a.sync().await;
    let personal = a.manager.status().vaults.iter().find(|v| v.kind == guivault_protocol::VaultKind::Personal).unwrap().id;
    let team = sharing::create_vault(&a.manager, "Équipe").await.unwrap();
    let client = a.manager.client().unwrap();

    // Un hôte du vault personnel déplacé vers l'équipe : pas une suppression.
    let host = Host::new("web-9", "10.0.0.9", "ops");
    a.ws.hosts.push(host.clone());
    a.sync().await;
    a.ws.vault_bindings.insert(host.id, team.id);
    let r = a.sync().await;
    assert_eq!(r.pushed, 1, "{r:?}");
    assert!(client.trash(personal).await.unwrap().is_empty(), "un déplacement ne remplit pas la corbeille");

    // Modifié puis supprimé dans l'équipe, d'une synchro à l'autre : il ne
    // revient pas (notre propre écriture relue n'annule pas la suppression),
    // et il est dans la corbeille, avec sa dernière version.
    a.host_mut(host.id).label = "web-9-final".into();
    a.sync().await;
    a.ws.hosts.retain(|h| h.id != host.id);
    let r = a.sync().await;
    assert_eq!(r.deleted_remotely, 1, "{r:?}");
    let trash = client.trash(team.id).await.unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].item_id, host.id);

    // Une rotation de clé par Guiterm emporte la corbeille avec elle.
    sync::rotate_vault_key(&a.manager, team.id).await.unwrap();
    let key = a.manager.vault_info(team.id).unwrap().key;
    let trash = client.trash(team.id).await.unwrap();
    let plain = guivault_crypto::open_item(&key, &team.id.to_string(), &host.id.to_string(), "host", &trash[0].ciphertext)
        .expect("la corbeille s'ouvre avec la nouvelle clé");
    assert!(String::from_utf8(plain).unwrap().contains("web-9-final"));
}
