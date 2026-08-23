//! Comparaison du **contenu** de deux fichiers, ligne à ligne.
//!
//! Le complément de [`crate::pane_sync`], qui compare des arborescences sur
//! le nom, la taille et la date : ici on répond à « qu'est-ce qui a changé
//! *dedans* », pour les deux fichiers qu'on a sous les yeux.
//!
//! **Groupé, pas intégral.** Un fichier de config de 800 lignes dont deux ont
//! bougé produit deux passages intéressants et 796 lignes de bruit. Comme
//! `diff -u`, seules les zones modifiées sont rendues, avec quelques lignes
//! de contexte autour — c'est ce qui permet de voir la différence sans la
//! chercher.
//!
//! Pur : deux textes en entrée, des blocs en sortie. Les cas qui se trompent
//! silencieusement (un fichier vide, un fichier sans saut de ligne final, un
//! déplacement de bloc) se testent donc sans serveur ni fichier.

use serde::Serialize;

/// Lignes de contexte gardées de part et d'autre d'une zone modifiée.
/// Trois, comme `diff -u` : assez pour reconnaître où on est dans le fichier,
/// pas assez pour noyer la modification.
pub const CONTEXT_LINES: usize = 3;

/// Au-delà, l'affichage cesse d'être une réponse. Un diff de dix mille
/// lignes ne se lit pas ; il est coupé, et le dire vaut mieux que le laisser
/// passer pour complet.
pub const MAX_DIFF_LINES: usize = 4_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    /// Présente des deux côtés — le contexte.
    Equal,
    /// Seulement à gauche.
    Deleted,
    /// Seulement à droite.
    Inserted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    /// Numéro de ligne à gauche, absent pour une ligne ajoutée.
    pub left_no: Option<usize>,
    /// Numéro de ligne à droite, absent pour une ligne supprimée.
    pub right_no: Option<usize>,
    pub text: String,
}

/// Un passage modifié, avec son contexte. Les blocs sont séparés par des
/// zones identiques trop longues pour être affichées.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub hunks: Vec<DiffHunk>,
    /// Les deux fichiers ont exactement le même contenu. Dit explicitement :
    /// « aucun bloc » se lirait aussi bien comme « la comparaison a échoué ».
    pub identical: bool,
    /// Coupé à [`MAX_DIFF_LINES`] : ce qui est montré est réel, mais il y a
    /// d'autres différences en dessous.
    pub truncated: bool,
    pub left_lines: usize,
    pub right_lines: usize,
}

/// Compare deux textes ligne à ligne et rend les passages modifiés.
pub fn diff_text(left: &str, right: &str) -> FileDiff {
    let diff = similar::TextDiff::from_lines(left, right);
    let mut hunks = Vec::new();
    let mut rendered = 0usize;
    let mut truncated = false;

    'groups: for group in diff.grouped_ops(CONTEXT_LINES) {
        let mut lines = Vec::new();
        for op in group {
            for change in diff.iter_changes(&op) {
                if rendered >= MAX_DIFF_LINES {
                    truncated = true;
                    if !lines.is_empty() {
                        hunks.push(DiffHunk { lines });
                    }
                    break 'groups;
                }
                let kind = match change.tag() {
                    similar::ChangeTag::Equal => LineKind::Equal,
                    similar::ChangeTag::Delete => LineKind::Deleted,
                    similar::ChangeTag::Insert => LineKind::Inserted,
                };
                lines.push(DiffLine {
                    kind,
                    // `similar` compte à partir de 0 ; les éditeurs et
                    // `diff` comptent à partir de 1, et c'est ce numéro-là
                    // que l'utilisateur va retrouver dans son fichier.
                    left_no: change.old_index().map(|i| i + 1),
                    right_no: change.new_index().map(|i| i + 1),
                    text: change.to_string_lossy().trim_end_matches(['\n', '\r']).to_string(),
                });
                rendered += 1;
            }
        }
        if !lines.is_empty() {
            hunks.push(DiffHunk { lines });
        }
    }

    FileDiff {
        identical: hunks.is_empty() && !truncated,
        hunks,
        truncated,
        left_lines: left.lines().count(),
        right_lines: right.lines().count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(diff: &FileDiff) -> Vec<(LineKind, &str)> {
        diff.hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .map(|l| (l.kind, l.text.as_str()))
            .collect()
    }

    #[test]
    fn two_identical_files_have_nothing_to_show() {
        let diff = diff_text("a\nb\nc\n", "a\nb\nc\n");
        assert!(diff.identical);
        assert!(diff.hunks.is_empty());
        assert!(!diff.truncated);
        assert_eq!((diff.left_lines, diff.right_lines), (3, 3));
    }

    #[test]
    fn a_changed_line_shows_both_versions_with_their_numbers() {
        let diff = diff_text("un\ndeux\ntrois\n", "un\nDEUX\ntrois\n");
        assert!(!diff.identical);
        assert_eq!(
            kinds(&diff),
            vec![
                (LineKind::Equal, "un"),
                (LineKind::Deleted, "deux"),
                (LineKind::Inserted, "DEUX"),
                (LineKind::Equal, "trois"),
            ]
        );
        let changed: Vec<_> = diff.hunks[0].lines.iter().filter(|l| l.kind != LineKind::Equal).collect();
        assert_eq!(changed[0].left_no, Some(2), "les numéros commencent à 1, comme dans un éditeur");
        assert_eq!(changed[0].right_no, None, "une ligne supprimée n'existe pas à droite");
        assert_eq!(changed[1].right_no, Some(2));
        assert_eq!(changed[1].left_no, None);
    }

    /// Ce qui distingue un diff d'une comparaison ligne par ligne : une
    /// insertion ne doit pas faire passer tout le reste du fichier pour
    /// modifié.
    #[test]
    fn an_inserted_line_does_not_shift_everything_after_it() {
        let diff = diff_text("a\nb\nc\nd\ne\nf\n", "a\nb\nNOUVEAU\nc\nd\ne\nf\n");
        let changed: Vec<_> = kinds(&diff).into_iter().filter(|(k, _)| *k != LineKind::Equal).collect();
        assert_eq!(changed, vec![(LineKind::Inserted, "NOUVEAU")]);
    }

    /// Les zones identiques trop longues sont sautées : c'est ce qui rend un
    /// fichier de 800 lignes dont deux ont bougé lisible.
    #[test]
    fn distant_changes_are_split_into_separate_hunks() {
        let mut left: Vec<String> = (0..60).map(|i| format!("ligne {i}")).collect();
        let mut right = left.clone();
        left[2] = "début modifié".into();
        right[2] = "début autre".into();
        left[55] = "fin modifiée".into();
        right[55] = "fin autre".into();
        let diff = diff_text(&left.join("\n"), &right.join("\n"));

        assert_eq!(diff.hunks.len(), 2, "deux passages éloignés, deux blocs");
        for hunk in &diff.hunks {
            assert!(hunk.lines.len() <= 2 * CONTEXT_LINES + 2, "un bloc ne garde que son contexte : {hunk:?}");
        }
    }

    #[test]
    fn an_empty_file_against_a_full_one_is_all_insertions() {
        let diff = diff_text("", "a\nb\n");
        assert!(!diff.identical);
        assert_eq!(
            kinds(&diff),
            vec![(LineKind::Inserted, "a"), (LineKind::Inserted, "b")]
        );
        assert_eq!(diff.left_lines, 0);
    }

    /// Un fichier sans saut de ligne final ne doit pas se présenter comme
    /// différent d'un fichier qui en a un... ou plutôt si, mais sur la
    /// dernière ligne seulement, et sans faire disparaître son texte.
    #[test]
    fn a_missing_final_newline_shows_the_line_it_concerns() {
        let diff = diff_text("a\nb", "a\nb\n");
        assert!(!diff.identical);
        let texts: Vec<_> = kinds(&diff).into_iter().map(|(_, t)| t.to_string()).collect();
        assert!(texts.contains(&"b".to_string()), "le texte de la ligne reste visible : {texts:?}");
    }

    #[test]
    fn a_very_large_diff_is_cut_and_says_so() {
        let left: String = (0..MAX_DIFF_LINES + 500).map(|i| format!("gauche {i}\n")).collect();
        let right: String = (0..MAX_DIFF_LINES + 500).map(|i| format!("droite {i}\n")).collect();
        let diff = diff_text(&left, &right);
        assert!(diff.truncated, "au-delà de la limite, le diff doit se dire coupé");
        let shown: usize = diff.hunks.iter().map(|h| h.lines.len()).sum();
        assert!(shown <= MAX_DIFF_LINES, "obtenu {shown} lignes");
        assert!(!diff.identical, "un diff coupé n'est pas un fichier identique");
    }
}
