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
use termius_core::guivault::transfer::{self, Place};
use termius_core::guivault::{LoginStep, Manager, sharing, sync};
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
    let n = transfer::apply(&mut local, &mut alice.ws, &[host.id], Place::Local, Place::Account { vault_id: Some(team.id) }, false, can_write(&alice.manager)).unwrap();
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
    let err = transfer::apply(&mut bob_local, &mut bob.ws, &[host.id], Place::Account { vault_id: Some(team.id) }, Place::Local, false, can_write(&bob.manager)).unwrap_err();
    assert!(err.to_string().contains("lecture seule"), "{err}");
    let err = transfer::apply(&mut bob_local, &mut bob.ws, &[host.id], Place::Account { vault_id: Some(team.id) }, Place::Account { vault_id: None }, false, can_write(&bob.manager)).unwrap_err();
    assert!(err.to_string().contains("lecture seule"), "{err}");
    let n = transfer::apply(&mut bob_local, &mut bob.ws, &[host.id], Place::Account { vault_id: Some(team.id) }, Place::Local, true, can_write(&bob.manager)).unwrap();
    assert_eq!(n, 2);
    let copy = bob_local.hosts.iter().find(|h| h.label == "db-1").unwrap();
    assert_ne!(copy.id, host.id);
    assert_eq!(local_vault::load(copy.id, SecretKind::Password).unwrap().as_deref(), Some("s3cret"), "le secret est dupliqué sous le nouvel id");
    let r = bob.sync().await;
    assert_eq!((r.pushed, r.pulled, r.deleted_remotely), (0, 0, 0), "une copie vers l'appareil ne touche pas au compte : {r:?}");

    // Alice copie l'hôte dans son vault personnel : un deuxième exemplaire,
    // poussé sous un nouvel id ; l'original reste partagé, Bob ne voit rien.
    let n = transfer::apply(&mut local, &mut alice.ws, &[host.id], Place::Account { vault_id: Some(team.id) }, Place::Account { vault_id: None }, true, can_write(&alice.manager)).unwrap();
    assert_eq!(n, 2);
    assert_eq!(alice.ws.hosts.len(), 2);
    let r = alice.sync().await;
    assert_eq!(r.pushed, 2, "{r:?}");
    let r = bob.sync().await;
    assert_eq!((r.pulled, r.removed_locally), (0, 0), "{r:?}");

    // Puis retire l'original vers son appareil : tombale côté serveur, Bob
    // perd l'hôte et le dossier.
    let n = transfer::apply(&mut local, &mut alice.ws, &[host.id], Place::Account { vault_id: Some(team.id) }, Place::Local, false, can_write(&alice.manager)).unwrap();
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
