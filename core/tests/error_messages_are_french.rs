//! Les messages d'erreur montrés à l'utilisateur sont en français.
//!
//! Pas une question de goût : `core/` n'a **aucune couche de traduction**, et
//! `src-tauri/src/commands/` relaie ses erreurs verbatim en 139 endroits via
//! `e.to_string()`. Un message écrit en anglais ici atterrit donc tel quel dans
//! une interface entièrement française — on y a lu « check_and_trust panicked »
//! jusqu'au 2026-08-17. `CLAUDE.md` tranche déjà la règle pour les libellés
//! d'interface, et un message d'erreur affiché en est un.
//!
//! Ce que ce test ne fait PAS : détecter du français mal écrit, ou de l'anglais
//! qui n'emploie aucune des tournures ci-dessous. Il attrape les formulations
//! récurrentes, qui sont celles qu'on réintroduit sans y penser en écrivant du
//! Rust.

use std::fs;
use std::path::{Path, PathBuf};

/// Tournures anglaises courantes dans les messages d'erreur Rust. Volontairement
/// des expressions et non des mots isolés : « invalid » ou « for » se
/// retrouveraient dans des noms de variables ou des chemins, et un garde-fou qui
/// crie au loup finit désactivé.
const ENGLISH_PHRASES: &[&str] = &[
    "could not",
    "cannot ",
    "not found",
    "failed to",
    "unable to",
    "panicked",
    "no stored",
    "does not exist",
    "is not a",
    "must be ",
];

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("core/src lisible") {
        let path = entry.expect("entrée de dossier lisible").path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Le corps du fichier avant `#[cfg(test)]` : les messages des tests sont des
/// fixtures, personne ne les lit dans l'app.
fn non_test_body(source: &str) -> &str {
    match source.find("#[cfg(test)]") {
        Some(cut) => &source[..cut],
        None => source,
    }
}

#[test]
fn user_facing_errors_are_written_in_french() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_sources(&src, &mut files);

    // Anti-vacuité : si la découverte des fichiers cassait, la boucle ne
    // vérifierait plus rien tout en restant verte.
    assert!(files.len() > 30, "seulement {} fichiers trouvés dans core/src", files.len());

    let mut offenders = Vec::new();
    let mut checked = 0usize;

    for file in &files {
        let source = fs::read_to_string(file).expect("source lisible");
        for (index, line) in non_test_body(&source).lines().enumerate() {
            // Seulement les messages que *nous* écrivons. Les comparaisons sur
            // la sortie d'une CLI externe (`aws_inventory`, `cloud_cli`,
            // `netdiag` cherchent « command not found » dans ce que le binaire
            // a imprimé) doivent rester en anglais : c'est le texte de l'autre
            // programme, pas le nôtre.
            if !line.contains("anyhow!(\"") && !line.trim_start().starts_with('"') {
                continue;
            }
            if !line.contains('"') {
                continue;
            }
            let is_message = line.contains("anyhow!(\"")
                || (line.trim_start().starts_with('"') && line.trim_end().ends_with(','));
            if !is_message {
                continue;
            }
            checked += 1;
            let lowered = line.to_lowercase();
            if let Some(phrase) = ENGLISH_PHRASES.iter().find(|p| lowered.contains(**p)) {
                offenders.push(format!(
                    "{}:{} — « {} » : {}",
                    file.strip_prefix(&src).unwrap_or(file).display(),
                    index + 1,
                    phrase.trim(),
                    line.trim()
                ));
            }
        }
    }

    assert!(checked > 50, "seulement {checked} messages inspectés — l'extraction ne marche plus");
    assert!(
        offenders.is_empty(),
        "messages d'erreur en anglais, qui atterriront tels quels dans l'interface française :\n{}",
        offenders.join("\n")
    );
}
