//! Sessions persistantes, contre un vrai `sshd` **et** un vrai `tmux`.
//!
//! C'est le seul test qui prouve la fonctionnalité. Les tests unitaires de
//! `persistent_shell` vérifient qu'on compose les bonnes chaînes ; ils ne
//! peuvent rien dire de la seule chose qui compte ici — qu'un shell survive à
//! la connexion qui l'a ouvert. Il faut deux connexions successives et un état
//! qui traverse l'intervalle, donc un serveur.
//!
//! **Ignoré, jamais échoué, quand tmux manque.** Le sondage est ce qui décide :
//! il répond `NoTmux`, le test le dit et s'arrête. C'est exactement le repli
//! que la fonctionnalité promet, et un test rouge sur une machine sans tmux
//! n'apprendrait rien à personne.
mod common;

use common::{ClientKey, TestSshd, test_host};
use std::time::Duration;
use termius_core::model::Workspace;
use termius_core::shell::quote;
use termius_core::ssh::{self, ShellInput, ShellSession};
use termius_core::{persistent_shell, persistent_shell::Probe};

/// Tape une ligne dans le shell, terminaison comprise.
async fn type_line(session: &ShellSession, line: &str) {
    session
        .input
        .send(ShellInput::Data(format!("{line}\n").into_bytes()))
        .await
        .expect("la session doit accepter la frappe");
}

/// Lit la sortie jusqu'à voir `needle`, ou échoue au bout de 30 s.
///
/// Attendre un motif plutôt que dormir un délai fixe : le temps que tmux
/// démarre et que le shell interne rende la main n'est pas connu d'avance, et
/// un `sleep` calibré sur cette machine deviendrait instable sur une autre.
async fn read_until(session: &mut ShellSession, needle: &str) -> String {
    let mut seen = String::new();
    let read = async {
        while let Some(chunk) = session.output.recv().await {
            seen.push_str(&String::from_utf8_lossy(&chunk));
            if seen.contains(needle) {
                return true;
            }
        }
        false
    };
    match tokio::time::timeout(Duration::from_secs(30), read).await {
        Ok(true) => seen,
        Ok(false) => panic!("la session s'est fermée sans jamais écrire {needle:?} — reçu :\n{seen}"),
        Err(_) => panic!("délai dépassé en attendant {needle:?} — reçu :\n{seen}"),
    }
}


/// Attend que tmux ait **enregistré** le client, en interrogeant la session
/// plutôt qu'en dormant.
///
/// C'est le seul signal fiable pour dire « la taille du pty a été appliquée » :
/// attendre un octet de la sortie ne garantit rien, le premier repeint pouvant
/// précéder la prise en compte du client — un premier jet de ce test mesurait
/// avant, et son témoin ne rétrécissait donc jamais.
async fn wait_until_attached(
    connection: &termius_core::ssh::Connection,
    key: &str,
    attached: u32,
) -> persistent_shell::RunningSession {
    for _ in 0..60 {
        let listing = persistent_shell::list(connection).await.expect("lister");
        if let Some(session) = listing.sessions.into_iter().find(|s| s.key == key)
            && session.attached == attached
        {
            return session;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("tmux n'a jamais rapporté {attached} client(s) sur {key}");
}

/// Attend qu'une condition sur la session devienne vraie, ou échoue en le
/// disant.
///
/// L'attente **est** l'assertion : c'est ce qui évite la course qu'un
/// « attendre le client, puis mesurer » laissait passer — tmux enregistre un
/// client avant d'appliquer sa taille, et la mesure tombait parfois entre les
/// deux.
async fn wait_for(
    connection: &termius_core::ssh::Connection,
    key: &str,
    what: &str,
    predicate: impl Fn(&persistent_shell::RunningSession) -> bool,
) -> persistent_shell::RunningSession {
    let mut last = None;
    for _ in 0..60 {
        let listing = persistent_shell::list(connection).await.expect("lister");
        if let Some(session) = listing.sessions.into_iter().find(|s| s.key == key) {
            if predicate(&session) {
                return session;
            }
            last = Some(session);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("{what} — dernier état observé : {last:?}");
}

/// Vérifie qu'une condition reste vraie pendant deux secondes, en
/// échantillonnant.
///
/// Pour prouver une **absence** de changement : un seul relevé pourrait tomber
/// avant que tmux ait agi et faire passer le test pour de mauvaises raisons.
async fn stays(
    connection: &termius_core::ssh::Connection,
    key: &str,
    predicate: impl Fn(&persistent_shell::RunningSession) -> bool,
) -> Option<persistent_shell::RunningSession> {
    for _ in 0..10 {
        let listing = persistent_shell::list(connection).await.expect("lister");
        let session = listing.sessions.into_iter().find(|s| s.key == key)?;
        if !predicate(&session) {
            return Some(session);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    None
}

#[tokio::test]
async fn a_shell_survives_the_connection_that_opened_it() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("tmux-persist", &key.public);
    let host = test_host(&sshd, &key, "test-tmux");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let session_key = persistent_shell::new_session_key();

    // ── Première connexion : rien ne tourne encore ────────────────────────
    let first = ssh::connect(&workspace, host_id).await.expect("première connexion");
    if persistent_shell::probe(&first, None).await == Probe::NoTmux {
        eprintln!("tmux absent de la machine de test — scénario ignoré");
        return;
    }
    assert_eq!(
        persistent_shell::probe(&first, Some(&session_key)).await,
        Probe::Absent,
        "une clé fraîchement générée ne peut pas déjà tourner",
    );

    let mut shell = ssh::open_shell_with_command(
        &first,
        80,
        24,
        false,
        Some(&persistent_shell::attach_command(&session_key, false)),
    )
    .await
    .expect("ouverture de la session tmux");

    // `PR''ET` et non `PRET` : le pty renvoie en écho ce qui est tapé, donc un
    // marqueur écrit tel quel dans la commande apparaîtrait dans la sortie
    // avant même d'avoir été exécuté. Coupé par une paire de quotes vides, le
    // seul « PRET » que le flux puisse contenir est celui que le shell a
    // réellement imprimé — donc la ligne entière a bien tourné.
    type_line(&shell, "cd /tmp; MARQUEUR=persistant-ok; echo PR''ET").await;
    read_until(&mut shell, "PRET").await;

    // Fermer comme l'app le fait en fermant un onglet : on lâche la session et
    // la connexion. Côté serveur, tmux se contente de détacher son client.
    drop(shell);
    drop(first);

    // ── Deuxième connexion : la session est toujours là ───────────────────
    let second = ssh::connect(&workspace, host_id).await.expect("seconde connexion");
    let probe = persistent_shell::probe(&second, Some(&session_key)).await;

    let mut resumed = ssh::open_shell_with_command(
        &second,
        80,
        24,
        false,
        Some(&persistent_shell::attach_command(&session_key, false)),
    )
    .await
    .expect("rattachement à la session tmux");

    // La variable **et** le dossier courant : deux états que seule une session
    // survivante peut porter. Un shell neuf répondrait « VALEUR=- » et le
    // dossier de connexion.
    type_line(&resumed, "echo VALEUR=$MARQUEUR-$(pwd)").await;
    let seen = read_until(&mut resumed, "VALEUR=persistant-ok-").await;

    // Le gestionnaire de sessions voit la même session, détachée ou non.
    drop(resumed);
    let listed = persistent_shell::list(&second).await;

    // Nettoyage avant les assertions : une session laissée derrière survivrait
    // au test lui-même — c'est tout le principe de la fonctionnalité.
    let after_kill = persistent_shell::kill(&second, &session_key).await;

    assert_eq!(probe, Probe::Running, "la session aurait dû être retrouvée");
    assert!(
        seen.contains("VALEUR=persistant-ok-/tmp"),
        "le dossier courant n'a pas survécu — reçu :\n{seen}",
    );

    let listed = listed.expect("lister les sessions");
    assert!(listed.tmux_available);
    let found = listed
        .sessions
        .iter()
        .find(|s| s.key == session_key)
        .unwrap_or_else(|| panic!("session absente du listing : {:?}", listed.sessions));
    assert!(found.windows >= 1, "une session tmux a au moins une fenêtre");
    assert!(
        found.created_at_ms.is_some_and(|ms| ms > 1_700_000_000_000),
        "date de création non lue : {:?}",
        found.created_at_ms,
    );

    // Et après le kill, elle a disparu de la liste que la commande rend.
    let after_kill = after_kill.expect("la session de test doit pouvoir être fermée");
    assert!(
        !after_kill.sessions.iter().any(|s| s.key == session_key),
        "la session tuée est encore listée : {:?}",
        after_kill.sessions,
    );
}

/// Terminer une session que l'app n'a pas ouverte est refusé **avant** que
/// quoi que ce soit parte sur le réseau. Le test crée une vraie session tmux
/// au nom personnel, demande sa mort, et vérifie qu'elle est toujours là.
#[tokio::test]
async fn a_session_this_app_did_not_open_is_never_killed() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("tmux-foreign", &key.public);
    let host = test_host(&sshd, &key, "test-foreign");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let connection = ssh::connect(&workspace, host_id).await.expect("connexion");
    if persistent_shell::probe(&connection, None).await == Probe::NoTmux {
        eprintln!("tmux absent de la machine de test — scénario ignoré");
        return;
    }

    // Un nom qui ne porte pas le préfixe de l'app, unique pour ne pas marcher
    // sur une vraie session de la machine de test.
    let foreign = format!("perso-{}", uuid::Uuid::new_v4().simple());
    ssh::run_command_capture(
        &connection,
        &format!("tmux new-session -d -s {}", quote(&foreign)),
    )
    .await
    .expect("créer la session témoin");

    let refused = persistent_shell::kill(&connection, &foreign).await;
    let still_there = ssh::run_command_capture(
        &connection,
        &format!("tmux has-session -t {} 2>/dev/null && echo VIVANTE", quote(&foreign)),
    )
    .await;

    // Nettoyage par nos propres moyens, puisque `kill` refuse (à raison).
    let _ = ssh::run_command_capture(
        &connection,
        &format!("tmux kill-session -t {}", quote(&foreign)),
    )
    .await;

    assert!(refused.is_err(), "terminer une session étrangère aurait dû être refusé");
    assert!(
        still_there.expect("interroger tmux").stdout.contains("VIVANTE"),
        "la session étrangère a été tuée",
    );

    // Et elle n'apparaît pas non plus dans ce que le gestionnaire propose.
    let listing = persistent_shell::list(&connection).await.expect("lister");
    assert!(
        !listing.sessions.iter().any(|s| s.key == foreign),
        "une session étrangère est proposée dans le gestionnaire",
    );
}

/// Le repli, sur le même serveur : sans clé de session, on ouvre un shell
/// ordinaire et rien ne subsiste. C'est ce que fait un hôte laissé sur
/// `PersistentShellMode::Off`, et ce que fait un hôte sans tmux.
#[tokio::test]
async fn an_ordinary_shell_keeps_nothing() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("tmux-plain", &key.public);
    let host = test_host(&sshd, &key, "test-plain");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let first = ssh::connect(&workspace, host_id).await.expect("première connexion");
    let mut shell = ssh::open_shell(&first, 80, 24, false).await.expect("shell ordinaire");
    type_line(&shell, "MARQUEUR=devrait-disparaitre; echo PR''ET").await;
    read_until(&mut shell, "PRET").await;
    drop(shell);
    drop(first);

    let second = ssh::connect(&workspace, host_id).await.expect("seconde connexion");
    let mut fresh = ssh::open_shell(&second, 80, 24, false).await.expect("second shell ordinaire");
    type_line(&fresh, "echo VALEUR=[$MARQUEUR]").await;
    let seen = read_until(&mut fresh, "VALEUR=[]").await;
    assert!(
        !seen.contains("VALEUR=[devrait-disparaitre]"),
        "un shell non persistant a gardé son état — le test de persistance ne prouverait plus rien",
    );
}

/// Observer une session ne doit pas la redimensionner pour ceux qui y
/// travaillent.
///
/// **Le piège mesuré, pas supposé.** `tmux attach -r` empêche le client
/// d'envoyer des frappes ; il ne l'empêche pas d'imposer sa taille. Sur tmux
/// 3.4, un client 80×24 fait passer une session 200×50 à 80×23. Et la fenêtre
/// vaut la taille du client **moins** la barre d'état, donc rejoindre à la
/// taille de la fenêtre lui prend encore une ligne. Ce test cloue les deux :
/// le témoin montre le rétrécissement, le cas nominal montre qu'il n'a pas
/// lieu.
#[tokio::test]
async fn observing_a_session_does_not_resize_it() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("tmux-observe", &key.public);
    let host = test_host(&sshd, &key, "test-observe");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let session_key = persistent_shell::new_session_key();
    let connection = ssh::connect(&workspace, host_id).await.expect("connexion");
    if persistent_shell::probe(&connection, None).await == Probe::NoTmux {
        eprintln!("tmux absent de la machine de test — scénario ignoré");
        return;
    }

    // Une session large, ouverte par un client large, puis détachée.
    let owner = ssh::open_shell_with_command(
        &connection, 200, 50, false, Some(&persistent_shell::attach_command(&session_key, false)),
    ).await.expect("ouverture");
    // Attendre que tmux ait vraiment pris la main : sans marqueur, la mesure
    // suivante pourrait tomber avant que la session existe.
    let mut owner = owner;
    type_line(&owner, "echo PR''ET").await;
    read_until(&mut owner, "PRET").await;
    drop(owner);
    // Attendre le détachement effectif, pas seulement le `drop` : sans ça le
    // client propriétaire compte encore, `wait_until_attached(…, 1)` rend la
    // main tout de suite en le voyant *lui*, et la mesure suivante tombe avant
    // que l'observateur ait imposé sa taille — le témoin ne rétrécissait plus.
    wait_until_attached(&connection, &session_key, 0).await;

    let find = |listing: persistent_shell::SessionListing| {
        listing.sessions.into_iter().find(|s| s.key == session_key)
    };
    let before = find(persistent_shell::list(&connection).await.expect("lister"))
        .expect("la session doit être listée");

    // 1. Le témoin : rejoindre avec un petit pty rétrécit bel et bien. C'est
    //    l'attente qui le prouve — si tmux ne rétrécissait pas, elle échoue.
    let (small_w, small_h) = (80, 24);
    let observer = ssh::open_shell_with_command(
        &connection, small_w, small_h, false, Some(&persistent_shell::observe_command(&session_key)),
    ).await.expect("observation étroite");
    wait_for(
        &connection, &session_key,
        "un client 80×24 en lecture seule aurait dû rétrécir la session — sans ça le cas nominal ne prouverait rien",
        |s| s.width == Some(small_w),
    ).await;
    drop(observer);
    wait_until_attached(&connection, &session_key, 0).await;

    // Le témoin a rétréci la session : la remettre à sa taille d'origine avant
    // de mesurer le cas nominal, sinon les deux mesures ne parlent pas de la
    // même chose.
    let restore = ssh::open_shell_with_command(
        &connection, 200, 50, false, Some(&persistent_shell::attach_command(&session_key, false)),
    ).await.expect("réattachement large");
    let restored = wait_for(
        &connection, &session_key, "la session n'est pas revenue à 200 de large",
        |s| s.width == Some(200),
    ).await;
    drop(restore);
    wait_until_attached(&connection, &session_key, 0).await;

    // 2. Le cas nominal : rejoindre à `client_size()` ne change rien, et ne le
    //    change pas non plus deux secondes plus tard.
    let (cols, rows) = restored.client_size().expect("taille connue");
    let observer = ssh::open_shell_with_command(
        &connection, cols, rows, false, Some(&persistent_shell::observe_command(&session_key)),
    ).await.expect("observation à la bonne taille");
    wait_until_attached(&connection, &session_key, 1).await;
    let drift = stays(&connection, &session_key,
        |s| (s.width, s.height) == (restored.width, restored.height)).await;
    drop(observer);

    let _ = persistent_shell::kill(&connection, &session_key).await;

    assert_eq!(before.width, Some(200), "la session de départ devait faire 200 de large");
    assert!(
        drift.is_none(),
        "observer a redimensionné la session : {:?}×{:?} → {:?}",
        restored.width, restored.height, drift.map(|s| (s.width, s.height)),
    );
}

/// On n'observe pas une session qui n'existe pas : `observe_command` s'attache,
/// il ne crée rien, et l'appelant doit avoir sondé avant.
#[tokio::test]
async fn observing_an_absent_session_fails_rather_than_creating_one() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("tmux-absent", &key.public);
    let host = test_host(&sshd, &key, "test-absent");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let connection = ssh::connect(&workspace, host_id).await.expect("connexion");
    if persistent_shell::probe(&connection, None).await == Probe::NoTmux {
        eprintln!("tmux absent de la machine de test — scénario ignoré");
        return;
    }

    let absent = persistent_shell::new_session_key();
    let output = ssh::run_command_capture(&connection, &persistent_shell::observe_command(&absent))
        .await
        .expect("la commande doit s'exécuter");
    assert_ne!(output.exit_code, Some(0), "tmux aurait dû refuser : {output:?}");

    let listing = persistent_shell::list(&connection).await.expect("lister");
    assert!(
        !listing.sessions.iter().any(|s| s.key == absent),
        "observer une session absente l'a créée",
    );
}

/// Masquer la barre d'état marche, et se lit ensuite dans le listing.
///
/// Deux choses d'un coup : que le point-virgule échappé arrive bien à tmux
/// comme séparateur de commandes (le shell distant est entre les deux), et que
/// `status_lines` retombe alors à 0 — dont dépend toute l'arithmétique de
/// `client_size`.
#[tokio::test]
async fn hiding_the_status_bar_is_applied_and_visible_in_the_listing() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("tmux-status", &key.public);
    let host = test_host(&sshd, &key, "test-status");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let connection = ssh::connect(&workspace, host_id).await.expect("connexion");
    if persistent_shell::probe(&connection, None).await == Probe::NoTmux {
        eprintln!("tmux absent de la machine de test — scénario ignoré");
        return;
    }
    let session_key = persistent_shell::new_session_key();

    let hidden = ssh::open_shell_with_command(
        &connection, 100, 30, false, Some(&persistent_shell::attach_command(&session_key, true)),
    ).await.expect("ouverture barre masquée");
    let with_hidden = wait_until_attached(&connection, &session_key, 1).await;
    drop(hidden);
    wait_until_attached(&connection, &session_key, 0).await;

    // Et l'inverse : ne pas masquer rend l'option à ce dont elle hérite, donc
    // la barre revient sur une machine qui l'a par défaut.
    let shown = ssh::open_shell_with_command(
        &connection, 100, 30, false, Some(&persistent_shell::attach_command(&session_key, false)),
    ).await.expect("ouverture barre visible");
    let with_shown = wait_until_attached(&connection, &session_key, 1).await;
    drop(shown);

    let _ = persistent_shell::kill(&connection, &session_key).await;

    assert_eq!(with_hidden.status_lines, 0, "la barre d'état n'a pas été masquée");
    // Barre masquée : la fenêtre occupe tout le client.
    assert_eq!((with_hidden.width, with_hidden.height), (Some(100), Some(30)));
    assert_eq!(with_shown.status_lines, 1, "la barre d'état n'est pas revenue");
    assert_eq!((with_shown.width, with_shown.height), (Some(100), Some(29)));
}
