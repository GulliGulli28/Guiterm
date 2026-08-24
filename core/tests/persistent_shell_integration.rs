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
        Some(&persistent_shell::attach_command(&session_key)),
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
        Some(&persistent_shell::attach_command(&session_key)),
    )
    .await
    .expect("rattachement à la session tmux");

    // La variable **et** le dossier courant : deux états que seule une session
    // survivante peut porter. Un shell neuf répondrait « VALEUR=- » et le
    // dossier de connexion.
    type_line(&resumed, "echo VALEUR=$MARQUEUR-$(pwd)").await;
    let seen = read_until(&mut resumed, "VALEUR=persistant-ok-").await;

    // Nettoyage avant les assertions : une session laissée derrière survivrait
    // au test lui-même — c'est tout le principe de la fonctionnalité.
    drop(resumed);
    let killed = ssh::run_command_capture(
        &second,
        &format!("tmux kill-session -t {}", quote(&session_key)),
    )
    .await;

    assert_eq!(probe, Probe::Running, "la session aurait dû être retrouvée");
    assert!(
        seen.contains("VALEUR=persistant-ok-/tmp"),
        "le dossier courant n'a pas survécu — reçu :\n{seen}",
    );
    killed.expect("la session de test doit pouvoir être fermée");
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
