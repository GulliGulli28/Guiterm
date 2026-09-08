//! Jouer un playbook Ansible depuis un **hôte relais**, comme une étape de
//! runbook.
//!
//! **Pourquoi un relais plutôt que la machine locale.** `ansible-playbook` ne
//! tourne pas nativement sous Windows, qui est la plateforme principale de
//! cette application : une étape qui l'exigerait localement serait indisponible
//! là où elle servirait le plus. Le playbook s'exécute donc *sur* un hôte SSH
//! qui a déjà Ansible — un nœud de contrôle, ce que les gens ont de toute façon
//! — et l'application ne fait que composer la commande, la lancer et lire ce
//! qui en sort. C'est aussi le modèle de Rundeck.
//!
//! **Ce module ne parle à personne.** Il compose une ligne de commande et lit
//! une sortie ; l'exécution et le streaming vivent dans la couche Tauri. C'est
//! ce qui permet de tester le `PLAY RECAP` sans Ansible ni flotte.

use crate::model::Host;
use serde::{Deserialize, Serialize};

/// Le nom d'un hôte **tel qu'Ansible le connaît**, quand on le sait.
///
/// C'est `HostSource::id` d'un hôte importé depuis un inventaire : le champ y
/// est documenté comme « l'identité sur laquelle un réimport apparie, et ce que
/// les playbooks utilisent ». C'est donc exactement ce que `--limit` attend, et
/// c'est la raison pour laquelle cette fonctionnalité tient en si peu de code —
/// l'information était déjà conservée par l'import.
///
/// `None` pour un hôte créé à la main : il n'a pas de nom Ansible, et lui en
/// inventer un depuis son libellé viserait une machine au hasard dans
/// l'inventaire du relais, ou aucune.
pub fn ansible_name(host: &Host) -> Option<&str> {
    let source = host.source.as_ref()?;
    (source.kind == "ansible").then_some(source.id.as_str())
}

/// Une ligne du `PLAY RECAP`, pour un hôte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecap {
    /// Le nom Ansible, tel qu'il apparaît dans le récapitulatif.
    pub name: String,
    pub ok: u32,
    pub changed: u32,
    pub unreachable: u32,
    pub failed: u32,
}

impl HostRecap {
    /// Cet hôte a-t-il un problème ?
    ///
    /// `unreachable` compte autant que `failed`, et les distinguer plus
    /// finement serait une fausse précision : une machine injoignable n'a pas
    /// appliqué le playbook, ce qui est le seul fait qui compte pour la suite
    /// de la procédure.
    pub fn failed(&self) -> bool {
        self.failed > 0 || self.unreachable > 0
    }
}

/// Compose la ligne `ansible-playbook`.
///
/// Tout ce qui est interpolé passe par les listes blanches de
/// [`crate::adaptive`] — les mêmes que le langage adaptatif, plutôt qu'une
/// seconde qui divergerait — puis est entouré de guillemets simples. Un chemin
/// ne peut donc pas sortir de son argument : la liste blanche exclut déjà le
/// guillemet simple, et POSIX désactive toute expansion à l'intérieur.
///
/// La commande est **inconditionnellement** limitée aux hôtes demandés. Un
/// playbook joué sans `--limit` s'appliquerait à tout l'inventaire du relais,
/// c'est-à-dire potentiellement à des machines que l'utilisateur n'a pas
/// cochées — exactement ce qu'une étape de runbook ne doit jamais faire.
pub fn build_command(
    playbook: &str,
    inventory: Option<&str>,
    limit: &[String],
) -> Result<String, String> {
    if !crate::adaptive::is_safe_path(playbook) {
        return Err(format!(
            "chemin de playbook refusé : « {playbook} ». Caractères autorisés : lettres, chiffres, \
             et - _ . + / \\ : espace ~"
        ));
    }
    if let Some(inventory) = inventory
        && !crate::adaptive::is_safe_path(inventory)
    {
        return Err(format!("chemin d'inventaire refusé : « {inventory} »"));
    }
    if limit.is_empty() {
        return Err(
            "aucune cible ne porte de nom Ansible : le playbook s'appliquerait à tout l'inventaire \
             du relais, ce qu'une étape de runbook ne doit jamais faire"
                .to_string(),
        );
    }
    for name in limit {
        if !crate::adaptive::is_safe_token(name) {
            return Err(format!("nom d'hôte Ansible refusé : « {name} »"));
        }
    }

    let mut command = String::from("ansible-playbook");
    if let Some(inventory) = inventory {
        command.push_str(&format!(" -i '{inventory}'"));
    }
    command.push_str(&format!(" '{playbook}'"));
    command.push_str(&format!(" --limit '{}'", limit.join(",")));
    Ok(command)
}

/// Ce qu'on peut vérifier d'une étape playbook **sans cible sous la main**,
/// donc au moment de l'enregistrer.
///
/// Même discipline que le langage adaptatif, validé par le parseur à
/// l'enregistrement plutôt qu'à l'exécution : une procédure qu'on ne découvre
/// invalide qu'au milieu d'un incident est le pire moment pour l'apprendre. Ce
/// que cette fonction ne peut pas vérifier — que le tag désigne exactement un
/// hôte, que le playbook existe sur le relais — dépend de l'espace de travail
/// ou de la machine distante, et se voit au lancement.
pub fn validate_step(relay_tag: &str, playbook: &str, inventory: &str) -> Result<(), String> {
    if relay_tag.trim().is_empty() {
        return Err("le tag du relais est vide : rien ne dit d'où jouer le playbook".to_string());
    }
    if playbook.trim().is_empty() {
        return Err("le chemin du playbook est vide".to_string());
    }
    // Une seule cible fictive : ce qui est vérifié ici, ce sont les chemins.
    build_command(playbook.trim(), (!inventory.trim().is_empty()).then_some(inventory.trim()), &["x".to_string()])
        .map(|_| ())
}

/// Lit le `PLAY RECAP` d'une sortie d'`ansible-playbook`.
///
/// Le récapitulatif est la seule partie de cette sortie qui soit structurée et
/// stable ; tout ce qui précède est de la prose destinée à un humain. On ne lit
/// donc que lui, et on ne prétend rien savoir du reste.
///
/// Rend une liste vide quand aucun récapitulatif n'est présent — ce qui arrive
/// pour de vrai : un playbook qui échoue à se parser, un inventaire introuvable
/// ou un `ansible-playbook` absent s'arrêtent avant d'en produire un. L'appelant
/// distingue ce cas du « tout va bien » par le code de sortie, jamais par le
/// silence du récapitulatif.
pub fn parse_recap(output: &str) -> Vec<HostRecap> {
    let mut recaps = Vec::new();
    let mut in_recap = false;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("PLAY RECAP") {
            in_recap = true;
            continue;
        }
        if !in_recap {
            continue;
        }
        if trimmed.is_empty() {
            // Une ligne vide clôt le récapitulatif. Ansible n'imprime rien
            // après, mais un playbook lancé plusieurs fois dans la même sortie
            // en aurait un par exécution — s'arrêter évite de mélanger les deux.
            break;
        }
        let Some((name, counters)) = trimmed.split_once(':') else { continue };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let field = |key: &str| -> u32 {
            counters
                .split_whitespace()
                .find_map(|pair| pair.strip_prefix(key)?.parse::<u32>().ok())
                .unwrap_or(0)
        };
        recaps.push(HostRecap {
            name: name.to_string(),
            ok: field("ok="),
            changed: field("changed="),
            unreachable: field("unreachable="),
            failed: field("failed="),
        });
    }
    recaps
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Host, HostSource};

    /// Une sortie réelle, récapitulatif compris — c'est ce format-là qu'il faut
    /// lire, pas une idée qu'on s'en fait.
    const SORTIE_REELLE: &str = r#"
PLAY [Déployer nginx] **********************************************************

TASK [Gathering Facts] *********************************************************
ok: [web-1]
ok: [db-1]

TASK [installer nginx] *********************************************************
changed: [web-1]
fatal: [db-1]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect"}

PLAY RECAP *********************************************************************
web-1                      : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
db-1                       : ok=1    changed=0    unreachable=1    failed=0    skipped=0    rescued=0    ignored=0
"#;

    #[test]
    fn le_recapitulatif_est_lu_hote_par_hote() {
        let recaps = parse_recap(SORTIE_REELLE);
        assert_eq!(recaps.len(), 2);
        assert_eq!(
            recaps[0],
            HostRecap { name: "web-1".into(), ok: 2, changed: 1, unreachable: 0, failed: 0 }
        );
        assert!(!recaps[0].failed());
        assert!(recaps[1].failed(), "un hôte injoignable n'a pas appliqué le playbook");
    }

    /// La prose au-dessus du récapitulatif contient « ok: [web-1] » et
    /// « fatal: [db-1] », qui ressemblent assez à des lignes de récapitulatif
    /// pour être ramassées par une lecture naïve.
    #[test]
    fn la_prose_avant_le_recapitulatif_est_ignoree() {
        let recaps = parse_recap(SORTIE_REELLE);
        assert!(recaps.iter().all(|r| r.ok > 0 || r.failed > 0 || r.unreachable > 0));
        assert_eq!(recaps.len(), 2, "seules les deux lignes du RECAP comptent");
    }

    /// Un playbook qui ne démarre pas n'imprime aucun récapitulatif. Le
    /// distinguer d'un succès est le travail du code de sortie, pas du nôtre —
    /// mais il ne faut pas inventer de lignes.
    #[test]
    fn une_sortie_sans_recapitulatif_ne_rend_rien() {
        assert!(parse_recap("ERROR! the playbook could not be found").is_empty());
        assert!(parse_recap("").is_empty());
    }

    #[test]
    fn une_etape_incomplete_est_refusee_des_l_enregistrement() {
        assert!(validate_step("", "site.yml", "").unwrap_err().contains("tag du relais"));
        assert!(validate_step("ansible", "", "").unwrap_err().contains("playbook"));
        assert!(validate_step("ansible", "s.yml'; id; '", "").is_err());
        assert!(validate_step("ansible", "site.yml", "").is_ok());
        assert!(validate_step("ansible", "site.yml", "/etc/ansible/hosts").is_ok());
    }

    #[test]
    fn la_commande_porte_toujours_un_limit() {
        let cmd = build_command("/opt/play/site.yml", Some("/opt/play/hosts"), &["web-1".into()])
            .unwrap();
        assert_eq!(
            cmd,
            "ansible-playbook -i '/opt/play/hosts' '/opt/play/site.yml' --limit 'web-1'"
        );
    }

    #[test]
    fn sans_inventaire_la_commande_laisse_ansible_choisir() {
        let cmd = build_command("site.yml", None, &["web-1".into(), "web-2".into()]).unwrap();
        assert_eq!(cmd, "ansible-playbook 'site.yml' --limit 'web-1,web-2'");
    }

    /// L'assertion de sûreté qui compte : sans `--limit`, le playbook
    /// s'appliquerait à tout l'inventaire du relais — donc à des machines que
    /// personne n'a cochées.
    #[test]
    fn une_liste_de_cibles_vide_est_refusee() {
        let err = build_command("site.yml", None, &[]).unwrap_err();
        assert!(err.contains("tout l'inventaire"), "{err}");
    }

    #[test]
    fn un_chemin_qui_casse_le_guillemet_est_refuse() {
        assert!(build_command("site.yml'; rm -rf /; echo '", None, &["web-1".into()]).is_err());
        assert!(build_command("site.yml", Some("h'; id; '"), &["web-1".into()]).is_err());
        assert!(build_command("site.yml", None, &["web-1'; id; '".into()]).is_err());
    }

    #[test]
    fn seul_un_hote_importe_depuis_un_inventaire_a_un_nom_ansible() {
        let mut importe = Host::new("web-1 (prod)", "10.0.0.1", "root");
        importe.source = Some(HostSource::ansible("web-1"));
        assert_eq!(ansible_name(&importe), Some("web-1"));

        let a_la_main = Host::new("web-1", "10.0.0.1", "root");
        assert_eq!(ansible_name(&a_la_main), None, "pas de source : pas de nom Ansible");

        let mut azure = Host::new("vm", "10.0.0.2", "root");
        azure.source = Some(HostSource::new("azure", "/subscriptions/…"));
        assert_eq!(ansible_name(&azure), None, "une autre source n'est pas un nom Ansible");
    }

    /// Le libellé Guiterm et le nom Ansible divergent dès qu'on renomme un
    /// hôte dans l'app — c'est le nom Ansible qui doit partir dans `--limit`.
    #[test]
    fn le_libelle_de_l_app_n_est_pas_le_nom_ansible() {
        let mut host = Host::new("Serveur web de prod", "10.0.0.1", "root");
        host.source = Some(HostSource::ansible("web-1"));
        assert_eq!(ansible_name(&host), Some("web-1"));
        assert_ne!(ansible_name(&host), Some(host.label.as_str()));
    }
}
