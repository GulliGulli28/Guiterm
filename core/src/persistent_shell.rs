//! Des sessions de terminal qui survivent à la connexion qui les porte.
//!
//! **Le manque auquel ça répond.** [`crate::ssh::open_shell`] demande un pty
//! puis un shell : chaque connexion en ouvre un neuf. La reconnexion
//! automatique de l'onglet rétablit donc bien un terminal, mais pas *le*
//! terminal — le dossier courant, le `tail -f` en cours, la commande à moitié
//! tapée sont partis avec le canal. Un VPN qui saute, un portable qui se met
//! en veille ou une mise à jour de l'app coûtent le même prix.
//!
//! **Le principe.** Faire tourner le shell dans une session `tmux` nommée,
//! côté serveur, et exécuter `tmux new-session -A -s <clé>` à la place du
//! shell. La clé est conservée avec l'onglet, donc la connexion suivante se
//! rattache exactement là où on en était.
//!
//! **Tout est au conditionnel, jamais bloquant.** Un hôte sans tmux ouvre un
//! shell ordinaire, comme avant : ce module renvoie [`Probe::NoTmux`] et
//! l'appelant continue. Refuser une connexion parce qu'un utilitaire de
//! confort manque serait une régression, pas une fonctionnalité.
//!
//! **Un seul aller-retour pour décider.** Le sondage dit d'un coup si tmux est
//! là *et* quelles sessions tournent — même forme que [`crate::facts::PROBE`] :
//! des lignes `CLÉ=valeur` qu'on relit en ignorant tout le reste, ce qui rend
//! le parsing indifférent aux MOTD et aux avertissements du shell.
//!
//! **Pourquoi lister plutôt que `tmux has-session`.** `has-session -t nom`
//! résout sa cible comme tmux résout n'importe quelle cible : le nom exact
//! d'abord, mais un préfixe ou un motif ensuite selon la version. Deux clés
//! dont l'une préfixe l'autre suffiraient à faire répondre « oui » pour la
//! mauvaise. Lister les noms et comparer ici est exact quelle que soit la
//! version de tmux — et c'est la même liste dont le gestionnaire de sessions
//! aura besoin.

use crate::shell::quote;
use crate::ssh::{self, Connection};
use uuid::Uuid;

/// Préfixe de toutes les sessions créées par cette app.
///
/// Sert à les reconnaître parmi les sessions tmux de l'utilisateur : les
/// siennes ne doivent jamais être proposées à la reprise ni, plus tard,
/// fermées par le gestionnaire de sessions.
pub const SESSION_PREFIX: &str = "guiterm-";

/// Longueur maximale d'une clé. tmux n'impose rien d'aussi précis ; c'est une
/// borne de bon sens sur une valeur qui arrive du `localStorage` du frontend.
const MAX_KEY_LEN: usize = 64;

/// Ce que le sondage a trouvé sur l'hôte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// tmux n'est pas installé (ou n'a pas pu être interrogé) : session non
    /// persistante, shell ordinaire, aucune erreur.
    NoTmux,
    /// tmux est là et la clé demandée y tourne déjà — on va s'y rattacher.
    Running,
    /// tmux est là, mais pas cette session : elle est à créer.
    Absent,
}

/// Une nouvelle clé, pour un onglet qui n'en a pas encore.
pub fn new_session_key() -> String {
    format!("{SESSION_PREFIX}{}", Uuid::new_v4())
}

/// Une clé est-elle utilisable telle quelle comme nom de session tmux ?
///
/// Deux raisons de valider une valeur qu'on génère nous-mêmes : elle fait
/// l'aller-retour par le `localStorage` du frontend (donc éditable à la main,
/// et corruptible), et **tmux interdit `.` et `:` dans un nom de session** —
/// il les lit comme les séparateurs `session:fenêtre.panneau`. Une clé qui en
/// contient ne produit pas une erreur franche mais une session au mauvais nom,
/// impossible à retrouver ensuite.
///
/// L'échappement de [`quote`] protège du shell ; ceci protège de tmux.
pub fn is_valid_session_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Le script de sondage : tmux est-il là, et quelles sessions tournent ?
///
/// `list-sessions` sort en échec quand aucun serveur tmux ne tourne — c'est le
/// cas normal sur une machine fraîche, pas une erreur, d'où le `2>/dev/null`
/// et le fait qu'on ne regarde que la sortie standard.
pub fn probe_script() -> &'static str {
    "if command -v tmux >/dev/null 2>&1; then \
echo GUITERM_TMUX=yes; \
tmux list-sessions -F 'GUITERM_SESSION=#{session_name}' 2>/dev/null; \
else echo GUITERM_TMUX=no; fi"
}

/// Relit la sortie du sondage. `key` absente signifie « je veux juste savoir
/// si tmux est là » : la réponse ne peut alors pas être [`Probe::Running`].
pub fn parse_probe(stdout: &str, key: Option<&str>) -> Probe {
    let mut has_tmux = false;
    let mut running = false;
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("GUITERM_TMUX=") {
            has_tmux = value == "yes";
        } else if let Some(name) = line.strip_prefix("GUITERM_SESSION=")
            && key.is_some_and(|k| k == name)
        {
            running = true;
        }
    }
    match (has_tmux, running) {
        (false, _) => Probe::NoTmux,
        (true, true) => Probe::Running,
        (true, false) => Probe::Absent,
    }
}

/// Les sessions créées par cette app qui tournent sur l'hôte, dans l'ordre où
/// tmux les rend. Les sessions personnelles de l'utilisateur sont écartées :
/// l'app n'a pas à proposer de reprendre, ni plus tard de fermer, ce qu'elle
/// n'a pas ouvert.
pub fn parse_session_names(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.trim().strip_prefix("GUITERM_SESSION="))
        .filter(|name| name.starts_with(SESSION_PREFIX))
        .map(str::to_string)
        .collect()
}

/// Sonde l'hôte. Une erreur de canal vaut [`Probe::NoTmux`] : le seul effet
/// est d'ouvrir un shell ordinaire, ce qui est exactement le repli voulu, et
/// c'est de toute façon la connexion elle-même qui échouera ensuite si le
/// problème est réel.
pub async fn probe(connection: &Connection, key: Option<&str>) -> Probe {
    match ssh::run_command_capture(connection, probe_script()).await {
        Ok(output) => parse_probe(&output.stdout, key),
        Err(_) => Probe::NoTmux,
    }
}

/// La commande à exécuter à la place du shell.
///
/// `-A` plutôt qu'un `new-session`/`attach-session` choisi d'après le sondage :
/// il crée *ou* rattache selon ce qui existe **au moment où il tourne**. Le
/// sondage n'est donc pas ce qui décide de la connexion — il ne décide que du
/// rejeu des commandes de démarrage —, et une session ouverte entre les deux
/// (par un autre onglet, ou à la main sur le serveur) est rattachée au lieu
/// d'échouer.
pub fn attach_command(key: &str) -> String {
    format!("tmux new-session -A -s {}", quote(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_are_valid_and_distinct() {
        let a = new_session_key();
        let b = new_session_key();
        assert_ne!(a, b);
        assert!(a.starts_with(SESSION_PREFIX));
        assert!(is_valid_session_key(&a), "{a} devrait être une clé valide");
    }

    /// Les deux caractères que tmux lit comme des séparateurs de cible. Une
    /// clé qui en contient ne casse rien bruyamment — elle crée une session
    /// introuvable ensuite, ce qui est pire.
    #[test]
    fn rejects_the_characters_tmux_reads_as_separators() {
        assert!(!is_valid_session_key("guiterm-a.b"));
        assert!(!is_valid_session_key("guiterm-a:b"));
    }

    #[test]
    fn rejects_what_should_never_reach_a_command_line() {
        for hostile in [
            "",
            "guiterm-a b",
            "guiterm-a'b",
            "guiterm-$(id)",
            "guiterm-a;id",
            "guiterm-a\nid",
            "guiterm-é",
        ] {
            assert!(!is_valid_session_key(hostile), "{hostile:?} accepté à tort");
        }
        assert!(!is_valid_session_key(&"a".repeat(MAX_KEY_LEN + 1)));
    }

    /// Et même en cas de clé valide, la commande reste intégralement citée :
    /// la validation et l'échappement sont deux filets, pas un seul.
    #[test]
    fn the_attach_command_quotes_its_key() {
        assert_eq!(
            attach_command("guiterm-abc"),
            "tmux new-session -A -s 'guiterm-abc'",
        );
    }

    #[test]
    fn no_tmux_when_the_probe_says_so() {
        assert_eq!(parse_probe("GUITERM_TMUX=no\n", Some("guiterm-a")), Probe::NoTmux);
    }

    /// Le MOTD, les avertissements de shell et tout ce que la connexion écrit
    /// avant la commande sont ignorés — c'est pour ça que le sondage émet des
    /// lignes `CLÉ=valeur` plutôt que du texte positionnel.
    #[test]
    fn unrelated_output_is_ignored() {
        let stdout = "Welcome to Ubuntu 24.04\n\
            GUITERM_TMUX=yes\n\
            GUITERM_SESSION=guiterm-abc\n\
            Last login: never\n";
        assert_eq!(parse_probe(stdout, Some("guiterm-abc")), Probe::Running);
        assert_eq!(parse_probe(stdout, Some("guiterm-zzz")), Probe::Absent);
    }

    /// Le cas que `tmux has-session -t` aurait pu confondre : une clé qui en
    /// préfixe une autre. La comparaison est exacte, donc « abc » ne trouve
    /// pas « abcdef ».
    #[test]
    fn a_prefix_is_not_a_match() {
        let stdout = "GUITERM_TMUX=yes\nGUITERM_SESSION=guiterm-abcdef\n";
        assert_eq!(parse_probe(stdout, Some("guiterm-abc")), Probe::Absent);
    }

    #[test]
    fn without_a_key_the_probe_only_reports_tmux() {
        let stdout = "GUITERM_TMUX=yes\nGUITERM_SESSION=guiterm-abc\n";
        assert_eq!(parse_probe(stdout, None), Probe::Absent);
    }

    #[test]
    fn only_this_app_s_sessions_are_listed() {
        let stdout = "GUITERM_TMUX=yes\n\
            GUITERM_SESSION=guiterm-abc\n\
            GUITERM_SESSION=travail\n\
            GUITERM_SESSION=guiterm-def\n";
        assert_eq!(parse_session_names(stdout), ["guiterm-abc", "guiterm-def"]);
    }
}
