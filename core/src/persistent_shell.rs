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
use serde::Serialize;
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

/// Une session persistante qui tourne en ce moment sur un hôte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningSession {
    /// Le nom tmux, qui est aussi la clé qu'un onglet garde.
    pub key: String,
    /// Millisecondes epoch de la création, comme `Host::last_facts_at_ms`.
    /// `None` quand tmux ne l'a pas rendue — une version qui ne connaît pas
    /// `session_created` rend une chaîne vide, pas une erreur.
    pub created_at_ms: Option<u64>,
    pub windows: u32,
    /// Combien de clients y sont attachés à l'instant. `0` veut dire que
    /// personne ne la regarde — c'est exactement ce qui distingue une session
    /// oubliée d'un onglet ouvert ailleurs.
    pub attached: u32,
    /// La taille de la fenêtre active, en cellules. Ce n'est pas de la
    /// décoration : s'attacher avec un pty d'une autre taille **redimensionne
    /// la session pour tout le monde**, y compris en lecture seule (mesuré sur
    /// tmux 3.4 : `attach -r` depuis un client 80×24 fait passer une session
    /// 200×50 à 80×23). Un observateur doit donc demander exactement cette
    /// taille-là. `None` si tmux ne l'a pas rendue.
    pub width: Option<u16>,
    pub height: Option<u16>,
    /// Combien de lignes la barre d'état de tmux occupe dans le client (0 si
    /// elle est masquée). Nécessaire parce que la *fenêtre* fait la taille du
    /// client **moins** la barre : rejoindre une session de 200×50 demande un
    /// pty de 200×51, pas de 200×50 — sinon on lui prend une ligne à chaque
    /// attache. Mesuré, pas déduit.
    pub status_lines: u16,
}

impl RunningSession {
    /// La taille de pty à demander pour rejoindre cette session **sans la
    /// redimensionner**.
    ///
    /// `None` quand tmux n'a pas rendu la taille : l'appelant retombe alors sur
    /// une valeur par défaut, ce qui rétrécira la session — désagréable, mais
    /// moins que refuser d'ouvrir le terminal.
    pub fn client_size(&self) -> Option<(u16, u16)> {
        Some((self.width?, self.height?.saturating_add(self.status_lines)))
    }
}

/// Ce qu'un hôte répond quand on lui demande ses sessions.
///
/// Trois réponses possibles et pas deux, même raison que les trois verdicts de
/// [`crate::drift`] : « aucune session » et « je ne peux pas savoir » ne sont
/// pas la même chose, et les confondre ferait passer un hôte sans tmux pour un
/// hôte propre.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListing {
    pub tmux_available: bool,
    pub sessions: Vec<RunningSession>,
}

/// Le script de sondage : tmux est-il là, et quelles sessions tournent ?
///
/// Un seul script pour les deux usages — décider quoi faire à la connexion, et
/// alimenter le gestionnaire de sessions. Les champs sont séparés par `|`, un
/// caractère qu'[`is_valid_session_key`] interdit dans une clé, donc le nom ne
/// peut jamais en contenir.
///
/// `list-sessions` sort en échec quand aucun serveur tmux ne tourne — c'est le
/// cas normal sur une machine fraîche, pas une erreur, d'où le `2>/dev/null`
/// et le fait qu'on ne regarde que la sortie standard.
pub fn probe_script() -> &'static str {
    "if command -v tmux >/dev/null 2>&1; then \
echo GUITERM_TMUX=yes; \
tmux list-sessions -F 'GUITERM_SESSION=#{session_name}|#{session_created}|#{session_windows}|#{session_attached}|#{window_width}|#{window_height}|#{status}' 2>/dev/null; \
else echo GUITERM_TMUX=no; fi"
}

/// tmux a-t-il répondu présent ?
fn tmux_present(stdout: &str) -> bool {
    stdout
        .lines()
        .filter_map(|line| line.trim().strip_prefix("GUITERM_TMUX="))
        .any(|value| value == "yes")
}

/// Les champs d'une ligne `GUITERM_SESSION=`, le nom en tête.
fn session_fields(line: &str) -> Option<(&str, Vec<&str>)> {
    let rest = line.trim().strip_prefix("GUITERM_SESSION=")?;
    let mut parts = rest.split('|');
    let name = parts.next()?;
    if name.is_empty() {
        return None;
    }
    Some((name, parts.collect()))
}

/// Relit la sortie du sondage. `key` absente signifie « je veux juste savoir
/// si tmux est là » : la réponse ne peut alors pas être [`Probe::Running`].
pub fn parse_probe(stdout: &str, key: Option<&str>) -> Probe {
    if !tmux_present(stdout) {
        return Probe::NoTmux;
    }
    let running = stdout
        .lines()
        .filter_map(session_fields)
        .any(|(name, _)| key.is_some_and(|k| k == name));
    if running { Probe::Running } else { Probe::Absent }
}

/// Combien de lignes vaut l'option `status` de tmux.
///
/// Elle vaut `on`, `off`, ou un nombre de 2 à 5. Un champ inconnu vaut 1 : la
/// barre est là par défaut, et se tromper dans ce sens fait rejoindre une
/// session avec une ligne de trop plutôt que d'une ligne trop peu — la
/// première ne coûte rien, la seconde rétrécit la session de quelqu'un.
fn parse_status_lines(value: &str) -> u16 {
    match value.trim() {
        "off" | "0" => 0,
        "on" | "" => 1,
        other => other.parse().unwrap_or(1),
    }
}

/// Les sessions créées par cette app qui tournent sur l'hôte, dans l'ordre où
/// tmux les rend. Les sessions personnelles de l'utilisateur sont écartées :
/// l'app n'a pas à proposer de reprendre — ni surtout de fermer — ce qu'elle
/// n'a pas ouvert.
pub fn parse_sessions(stdout: &str) -> Vec<RunningSession> {
    stdout
        .lines()
        .filter_map(session_fields)
        .filter(|(name, _)| name.starts_with(SESSION_PREFIX))
        .map(|(name, fields)| RunningSession {
            key: name.to_string(),
            // Secondes côté tmux, millisecondes partout ici. Un champ vide ou
            // illisible vaut « inconnu », jamais 1970.
            created_at_ms: fields
                .first()
                .and_then(|v| v.parse::<u64>().ok())
                .map(|secs| secs.saturating_mul(1000)),
            windows: fields.get(1).and_then(|v| v.parse().ok()).unwrap_or(0),
            attached: fields.get(2).and_then(|v| v.parse().ok()).unwrap_or(0),
            width: fields.get(3).and_then(|v| v.parse().ok()),
            height: fields.get(4).and_then(|v| v.parse().ok()),
            status_lines: fields.get(5).map_or(1, |v| parse_status_lines(v)),
        })
        .collect()
}

/// Les sessions de cette app sur `connection`.
///
/// Contrairement à [`probe`], une erreur remonte : l'utilisateur a demandé à
/// voir la liste, et lui rendre « aucune session » parce que la commande a
/// échoué serait un mensonge.
pub async fn list(connection: &Connection) -> anyhow::Result<SessionListing> {
    let output = ssh::run_command_capture(connection, probe_script()).await?;
    Ok(SessionListing {
        tmux_available: tmux_present(&output.stdout),
        sessions: parse_sessions(&output.stdout),
    })
}

/// La commande qui termine une session.
///
/// Refuse tout ce qui ne porte pas le préfixe de l'app. C'est la garde qui
/// compte le plus de ce module : la clé fait l'aller-retour par le frontend, et
/// un `kill-session -t travail` détruirait la session personnelle de
/// l'utilisateur sans confirmation possible.
pub fn kill_command(key: &str) -> anyhow::Result<String> {
    if !is_valid_session_key(key) || !key.starts_with(SESSION_PREFIX) {
        anyhow::bail!("« {key} » n'est pas une session ouverte par cette application");
    }
    Ok(format!("tmux kill-session -t {}", quote(key)))
}

/// Termine une session, puis rend la liste à jour — l'appelant veut de toute
/// façon réafficher ce qui reste.
pub async fn kill(connection: &Connection, key: &str) -> anyhow::Result<SessionListing> {
    let output = ssh::run_command_capture(connection, &kill_command(key)?).await?;
    if output.exit_code != Some(0) {
        // tmux écrit « can't find session » sur stderr et sort en 1. Le relayer
        // vaut mieux que de rendre une liste inchangée sans rien dire.
        let detail = output.stderr.trim();
        anyhow::bail!(
            "la session n'a pas pu être terminée{}",
            if detail.is_empty() { String::new() } else { format!(" : {detail}") }
        );
    }
    list(connection).await
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

/// Les options que l'app pose sur ses propres sessions tmux.
///
/// Deux réglages, tous deux réappliqués à **chaque** rattachement : sans ça,
/// changer d'avis n'aurait aucun effet sur les sessions déjà ouvertes. Jamais
/// posées en observation — changer l'apparence d'une session qu'on ne fait que
/// regarder la changerait pour ceux qui y travaillent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionAppearance {
    /// Masquer la barre d'état de tmux, pour qu'une session persistante
    /// ressemble à un terminal ordinaire.
    pub hide_status_bar: bool,
    /// Laisser tmux recevoir les événements souris. C'est ce qui rend la
    /// molette utile : sans ça elle fait défiler le tampon de xterm, qui est
    /// vide puisque tmux repeint l'écran entier — l'historique est **dans**
    /// tmux, et seul son mode copie y donne accès.
    pub mouse: bool,
}

impl Default for SessionAppearance {
    fn default() -> Self {
        Self { hide_status_bar: true, mouse: true }
    }
}

/// La commande à exécuter à la place du shell./// La commande à exécuter à la place du shell.
///
/// `-A` plutôt qu'un `new-session`/`attach-session` choisi d'après le sondage :
/// il crée *ou* rattache selon ce qui existe **au moment où il tourne**. Le
/// sondage n'est donc pas ce qui décide de la connexion — il ne décide que du
/// rejeu des commandes de démarrage —, et une session ouverte entre les deux
/// (par un autre onglet, ou à la main sur le serveur) est rattachée au lieu
/// d'échouer.
pub fn attach_command(key: &str, appearance: SessionAppearance) -> String {
    let quoted = quote(key);
    // `\;` : le shell distant le rend à tmux comme un point-virgule littéral,
    // qui sépare deux commandes tmux. Vérifié contre un vrai tmux 3.4, en
    // création comme en rattachement.
    //
    // `-u` plutôt qu'une valeur explicite quand l'option n'est pas voulue :
    // `-u` la remet à ce dont elle hérite, donc au `.tmux.conf` de
    // l'utilisateur. Forcer `off` couperait une souris ou une barre d'état que
    // quelqu'un a délibérément activées dans sa propre configuration.
    let option = |name: &str, wanted: bool, value: &str| {
        if wanted {
            format!(" \\; set-option -t {quoted} {name} {value}")
        } else {
            format!(" \\; set-option -u -t {quoted} {name}")
        }
    };
    format!(
        "tmux new-session -A -s {quoted}{}{}",
        option("status", appearance.hide_status_bar, "off"),
        option("mouse", appearance.mouse, "on"),
    )
}

/// La commande pour **observer** une session sans pouvoir y taper.
///
/// `attach-session` et non `new-session -A` : on n'observe pas une session
/// qu'on viendrait de créer. Si elle n'existe plus, tmux sort en erreur — et
/// l'appelant a de toute façon sondé avant, pour le dire proprement plutôt que
/// d'ouvrir un terminal qui meurt.
///
/// `-r` empêche ce client d'envoyer des frappes. Il n'empêche **pas** de
/// redimensionner la session : c'est au pty d'être demandé à la bonne taille
/// (voir [`RunningSession::width`]).
pub fn observe_command(key: &str) -> String {
    format!("tmux attach-session -r -t {}", quote(key))
}

/// La ligne à donner à quelqu'un d'autre pour qu'il observe la même session
/// depuis son propre terminal.
///
/// L'app ne peut pas *inviter* : il n'y a pas de relais, et la seule façon de
/// rejoindre une session est d'avoir déjà un accès SSH à l'hôte. Ce qu'elle
/// peut faire, c'est écrire la commande exacte — `-t` pour forcer un pty, sans
/// quoi tmux refuse de s'attacher (« open terminal failed: not a terminal »).
pub fn share_command(user: &str, address: &str, port: u16, key: &str) -> String {
    let target = format!("{user}@{address}");
    let port_flag = if port == 22 { String::new() } else { format!("-p {port} ") };
    format!("ssh {port_flag}-t {} {}", quote(&target), quote(&observe_command(key)))
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
    fn the_attach_command_quotes_its_key_and_carries_its_options() {
        let both = attach_command("guiterm-abc", SessionAppearance { hide_status_bar: true, mouse: true });
        assert!(both.starts_with("tmux new-session -A -s 'guiterm-abc'"), "{both}");
        // Des points-virgules échappés pour le shell distant, qui les rend à
        // tmux comme séparateurs de commandes.
        assert!(both.contains(r" \; set-option -t 'guiterm-abc' status off"), "{both}");
        assert!(both.contains(r" \; set-option -t 'guiterm-abc' mouse on"), "{both}");
    }

    /// Ne pas vouloir une option, ce n'est pas la couper de force : `-u` la
    /// rend à ce dont elle hérite, donc au `.tmux.conf` de l'utilisateur.
    /// Quelqu'un qui a coupé sa barre — ou activé sa souris — chez lui ne doit
    /// pas voir l'app décider à sa place.
    #[test]
    fn unwanted_options_are_unset_rather_than_forced() {
        let neither = attach_command("guiterm-abc", SessionAppearance { hide_status_bar: false, mouse: false });
        assert!(neither.contains(r"set-option -u -t 'guiterm-abc' status"), "{neither}");
        assert!(neither.contains(r"set-option -u -t 'guiterm-abc' mouse"), "{neither}");
        assert!(!neither.contains("status on"), "{neither}");
        assert!(!neither.contains("mouse off"), "{neither}");
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
            GUITERM_SESSION=guiterm-abc|1756000000|2|1\n\
            GUITERM_SESSION=travail|1756000000|9|0\n\
            GUITERM_SESSION=guiterm-def|1756000100|1|0\n";
        let keys: Vec<_> = parse_sessions(stdout).into_iter().map(|s| s.key).collect();
        assert_eq!(keys, ["guiterm-abc", "guiterm-def"]);
    }

    #[test]
    fn a_listed_session_carries_its_age_windows_clients_and_size() {
        let stdout = "GUITERM_TMUX=yes\nGUITERM_SESSION=guiterm-abc|1756000000|3|1|200|50\n";
        assert_eq!(
            parse_sessions(stdout),
            [RunningSession {
                key: "guiterm-abc".to_string(),
                // Secondes chez tmux, millisecondes ici.
                created_at_ms: Some(1_756_000_000_000),
                windows: 3,
                attached: 1,
                // Lue pour pouvoir s'attacher **sans** redimensionner la
                // session — mesuré : un client plus petit la rétrécit, même en
                // lecture seule.
                width: Some(200),
                height: Some(50),
                status_lines: 1,
            }],
        );
    }

    /// L'arithmétique que la mesure a imposée : la fenêtre fait la taille du
    /// client **moins** la barre d'état, donc rejoindre une session de 200×50
    /// demande un pty de 200×51. Demander 200×50 lui prendrait une ligne — et
    /// une de plus à chaque attache suivante.
    #[test]
    fn joining_a_session_asks_for_the_status_bar_too() {
        let session = |status_lines| RunningSession {
            key: "guiterm-abc".to_string(),
            created_at_ms: None,
            windows: 1,
            attached: 0,
            width: Some(200),
            height: Some(50),
            status_lines,
        };
        assert_eq!(session(1).client_size(), Some((200, 51)));
        assert_eq!(session(0).client_size(), Some((200, 50)));
        assert_eq!(session(2).client_size(), Some((200, 52)));
    }

    #[test]
    fn a_session_of_unknown_size_asks_for_nothing() {
        let unknown = RunningSession {
            key: "guiterm-abc".to_string(),
            created_at_ms: None,
            windows: 1,
            attached: 0,
            width: None,
            height: None,
            status_lines: 1,
        };
        assert_eq!(unknown.client_size(), None);
    }

    /// `status` vaut `on`, `off`, ou un nombre. Un champ vide ou inconnu vaut
    /// 1 : se tromper dans ce sens ajoute une ligne au client, ce qui ne coûte
    /// rien, là où l'inverse rétrécit la session de quelqu'un.
    #[test]
    fn the_status_option_is_read_in_all_its_spellings() {
        assert_eq!(parse_status_lines("on"), 1);
        assert_eq!(parse_status_lines("off"), 0);
        assert_eq!(parse_status_lines("3"), 3);
        assert_eq!(parse_status_lines(""), 1);
        assert_eq!(parse_status_lines("n'importe quoi"), 1);
    }

    /// Une version de tmux qui ne connaît pas un de ces `#{...}` rend une
    /// chaîne vide, pas une erreur : la session doit rester listée, avec ce
    /// qu'on ignore marqué comme inconnu plutôt que comme zéro daté de 1970.
    #[test]
    fn a_session_stays_listed_when_tmux_omits_its_fields() {
        let stdout = "GUITERM_TMUX=yes\nGUITERM_SESSION=guiterm-abc||\n";
        assert_eq!(
            parse_sessions(stdout),
            [RunningSession {
                key: "guiterm-abc".to_string(),
                created_at_ms: None,
                windows: 0,
                attached: 0,
                width: None,
                height: None,
                status_lines: 1,
            }],
        );
    }

    #[test]
    fn a_listing_tells_no_tmux_apart_from_no_sessions() {
        assert!(!tmux_present("GUITERM_TMUX=no\n"));
        assert!(tmux_present("GUITERM_TMUX=yes\n"));
    }

    /// La garde qui compte le plus du module : la clé revient du frontend, et
    /// terminer une session que l'app n'a pas ouverte détruirait le travail de
    /// quelqu'un sans confirmation possible.
    #[test]
    fn only_this_app_s_sessions_can_be_killed() {
        assert!(kill_command("travail").is_err());
        assert!(kill_command("").is_err());
        assert!(kill_command("guiterm-a;id").is_err());
        assert!(kill_command("guiterm-a b").is_err());
        assert_eq!(
            kill_command("guiterm-abc").unwrap(),
            "tmux kill-session -t 'guiterm-abc'",
        );
    }

    /// On n'observe pas une session qu'on créerait : `attach-session`, jamais
    /// `new-session -A`. Et la clé reste citée, comme partout ailleurs.
    #[test]
    fn observing_never_creates_a_session() {
        assert_eq!(
            observe_command("guiterm-abc"),
            "tmux attach-session -r -t 'guiterm-abc'",
        );
    }

    /// La ligne donnée à un collègue doit forcer un pty (`-t`), sans quoi tmux
    /// refuse de s'attacher, et ne mentionner le port que s'il n'est pas
    /// standard — c'est une commande qu'on relit avant de la coller. La
    /// commande interne est citée d'un bloc : c'est un seul argument pour
    /// `ssh`, pas cinq mots qui traînent.
    #[test]
    fn the_shared_command_forces_a_tty_and_only_names_an_unusual_port() {
        let line = share_command("ubuntu", "10.0.0.1", 22, "guiterm-abc");
        // `-t` : sans pty forcé, tmux refuse de s'attacher (« open terminal
        // failed: not a terminal »), et l'erreur ne dit pas quoi corriger.
        assert!(line.starts_with("ssh -t "), "{line}");
        assert!(line.contains(&quote("ubuntu@10.0.0.1")), "{line}");
        // La commande distante est **un seul argument** cité, pas cinq mots
        // qui traînent : c'est ce qui la fait survivre au shell de l'hôte.
        assert!(line.ends_with(&quote(&observe_command("guiterm-abc"))), "{line}");
        // Le port n'apparaît que s'il n'est pas standard — la ligne est faite
        // pour être relue avant d'être collée.
        assert!(!line.contains("-p "), "{line}");
        assert!(share_command("ubuntu", "10.0.0.1", 2222, "guiterm-abc").contains("-p 2222 "));
    }

    /// Le nom est le premier champ : une clé ne peut pas contenir de `|`
    /// (`is_valid_session_key` l'interdit), donc découper dessus est sûr.
    #[test]
    fn the_probe_still_recognises_a_key_among_the_new_fields() {
        let stdout = "GUITERM_TMUX=yes\nGUITERM_SESSION=guiterm-abc|1756000000|1|0\n";
        assert_eq!(parse_probe(stdout, Some("guiterm-abc")), Probe::Running);
        assert_eq!(parse_probe(stdout, Some("guiterm-ab")), Probe::Absent);
        assert!(!is_valid_session_key("guiterm-a|b"));
    }
}
