//! Comparaison de deux arborescences de panneaux de transfert.
//!
//! Le geste qui manquait : « qu'est-ce qui diffère entre ici et là-bas, et
//! comment le rattraper ». Jusqu'ici il fallait ouvrir les deux dossiers côte
//! à côte et lire les listings à l'œil, dossier par dossier.
//!
//! **Sur quoi porte la comparaison** : le nom, la taille et la date de
//! modification — jamais le contenu. Comparer les contenus voudrait dire
//! relire les deux arbres entiers à travers le réseau, ce qui coûte
//! exactement le prix d'une copie complète : autant tout recopier. C'est le
//! même compromis que `rsync` sans `--checksum`, et il a la même conséquence
//! — deux fichiers de même taille modifiés à la même seconde sont réputés
//! identiques.
//!
//! Tout est pur ici : [`compare`] prend deux inventaires (produits par
//! `crate::pane_ops::inventory`) et rend les différences. Les cas
//! intéressants — la tolérance sur les horloges, un fichier présent des deux
//! côtés avec des tailles différentes — se testent donc sans serveur.

use crate::pane_ops::{FileFacts, Inventory};
use serde::Serialize;
use std::collections::HashMap;

/// Écart de date en deçà duquel deux fichiers de même taille sont réputés
/// identiques.
///
/// Deux secondes, comme `rsync` : les systèmes de fichiers ne stockent pas
/// tous la même granularité (FAT arrondit à deux secondes), SFTP ne
/// transporte que des secondes entières, et les horloges de deux machines ne
/// sont jamais exactement synchronisées. Sans cette tolérance, une
/// arborescence fraîchement synchronisée se re-signalerait comme différente.
pub const CLOCK_TOLERANCE_SECS: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DifferenceKind {
    /// Présent à gauche seulement.
    OnlyLeft,
    /// Présent à droite seulement.
    OnlyRight,
    /// Des deux côtés, celui de gauche est plus récent.
    NewerLeft,
    /// Des deux côtés, celui de droite est plus récent.
    NewerRight,
    /// Des deux côtés, même date à la tolérance près, mais pas la même
    /// taille. Un cas qui mérite d'être distingué : il n'y a pas de « plus
    /// récent » à proposer, et c'est souvent le signe d'une copie
    /// interrompue.
    SizeDiffers,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    /// Chemin relatif à la racine des deux côtés.
    pub path: String,
    pub kind: DifferenceKind,
    pub left: Option<FileFacts>,
    pub right: Option<FileFacts>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub differences: Vec<Difference>,
    /// Combien de fichiers sont identiques des deux côtés. Affiché parce que
    /// « 3 différences » ne veut rien dire sans savoir si c'est sur dix
    /// fichiers ou sur dix mille.
    pub identical: usize,
    /// Un des deux inventaires a été plafonné : la comparaison ne couvre pas
    /// tout. Dit à l'utilisateur, sans quoi une synchronisation partielle
    /// passerait pour terminée.
    pub truncated: bool,
}

/// Compare deux inventaires. Le résultat ne contient **que** les différences,
/// triées par chemin — c'est ce que l'utilisateur veut voir, et la liste des
/// fichiers identiques n'est utile que comptée.
pub fn compare(left: &Inventory, right: &Inventory) -> Comparison {
    let right_by_path: HashMap<&str, &FileFacts> =
        right.files.iter().map(|f| (f.path.as_str(), f)).collect();
    let left_by_path: HashMap<&str, &FileFacts> =
        left.files.iter().map(|f| (f.path.as_str(), f)).collect();

    let mut differences = Vec::new();
    let mut identical = 0usize;

    for file in &left.files {
        match right_by_path.get(file.path.as_str()) {
            None => differences.push(Difference {
                path: file.path.clone(),
                kind: DifferenceKind::OnlyLeft,
                left: Some(file.clone()),
                right: None,
            }),
            Some(other) => {
                let delta = file.modified as i64 - other.modified as i64;
                let same_time = delta.abs() <= CLOCK_TOLERANCE_SECS;
                let kind = if same_time && file.size == other.size {
                    identical += 1;
                    continue;
                } else if same_time {
                    DifferenceKind::SizeDiffers
                } else if delta > 0 {
                    DifferenceKind::NewerLeft
                } else {
                    DifferenceKind::NewerRight
                };
                differences.push(Difference {
                    path: file.path.clone(),
                    kind,
                    left: Some(file.clone()),
                    right: Some((*other).clone()),
                });
            }
        }
    }

    for file in &right.files {
        if !left_by_path.contains_key(file.path.as_str()) {
            differences.push(Difference {
                path: file.path.clone(),
                kind: DifferenceKind::OnlyRight,
                left: None,
                right: Some(file.clone()),
            });
        }
    }

    differences.sort_by(|a, b| a.path.cmp(&b.path));
    Comparison {
        differences,
        identical,
        truncated: left.truncated || right.truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(path: &str, size: u64, modified: u64) -> FileFacts {
        FileFacts { path: path.to_string(), size, modified }
    }

    fn inventory(files: Vec<FileFacts>) -> Inventory {
        Inventory { files, truncated: false }
    }

    #[test]
    fn identical_files_are_counted_not_listed() {
        let left = inventory(vec![facts("a.txt", 10, 1000), facts("sous/b.txt", 20, 1000)]);
        let right = inventory(vec![facts("a.txt", 10, 1000), facts("sous/b.txt", 20, 1000)]);
        let outcome = compare(&left, &right);
        assert!(outcome.differences.is_empty());
        assert_eq!(outcome.identical, 2);
    }

    #[test]
    fn a_file_missing_on_one_side_is_reported_on_that_side() {
        let left = inventory(vec![facts("a.txt", 10, 1000)]);
        let right = inventory(vec![facts("b.txt", 10, 1000)]);
        let outcome = compare(&left, &right);
        assert_eq!(outcome.differences.len(), 2);
        // Triées par chemin : a.txt puis b.txt.
        assert_eq!(outcome.differences[0].kind, DifferenceKind::OnlyLeft);
        assert_eq!(outcome.differences[1].kind, DifferenceKind::OnlyRight);
        assert_eq!(outcome.identical, 0);
    }

    #[test]
    fn the_newer_side_is_the_one_with_the_later_date() {
        let left = inventory(vec![facts("a.txt", 10, 2000), facts("b.txt", 10, 1000)]);
        let right = inventory(vec![facts("a.txt", 10, 1000), facts("b.txt", 10, 2000)]);
        let outcome = compare(&left, &right);
        assert_eq!(outcome.differences[0].kind, DifferenceKind::NewerLeft);
        assert_eq!(outcome.differences[1].kind, DifferenceKind::NewerRight);
    }

    /// Le cas qui rendrait la comparaison inutilisable si la tolérance
    /// n'existait pas : une arborescence qu'on vient de synchroniser, dont les
    /// dates ne peuvent pas coïncider à la seconde près.
    #[test]
    fn a_two_second_clock_gap_is_not_a_difference() {
        let left = inventory(vec![facts("a.txt", 10, 1000)]);
        let right = inventory(vec![facts("a.txt", 10, 1002)]);
        assert_eq!(compare(&left, &right).identical, 1);

        let further = inventory(vec![facts("a.txt", 10, 1003)]);
        assert_eq!(compare(&left, &further).differences[0].kind, DifferenceKind::NewerRight);
    }

    /// Même date, taille différente : il n'y a pas de « plus récent » à
    /// proposer, et c'est typiquement une copie interrompue.
    #[test]
    fn same_date_but_a_different_size_is_its_own_case() {
        let left = inventory(vec![facts("a.txt", 10, 1000)]);
        let right = inventory(vec![facts("a.txt", 999, 1000)]);
        let outcome = compare(&left, &right);
        assert_eq!(outcome.differences[0].kind, DifferenceKind::SizeDiffers);
        assert_eq!(outcome.identical, 0);
    }

    #[test]
    fn a_capped_inventory_makes_the_whole_comparison_partial() {
        let left = Inventory { files: vec![facts("a.txt", 10, 1000)], truncated: true };
        let right = inventory(vec![facts("a.txt", 10, 1000)]);
        assert!(compare(&left, &right).truncated, "le plafond d'un seul côté suffit");
    }

    #[test]
    fn both_sides_of_a_difference_are_reported() {
        let left = inventory(vec![facts("a.txt", 10, 2000)]);
        let right = inventory(vec![facts("a.txt", 20, 1000)]);
        let difference = &compare(&left, &right).differences[0];
        // L'interface affiche les deux tailles et les deux dates : « 10 o le
        // 3 mars » contre « 20 o le 1er mars » est ce qui permet de choisir.
        assert_eq!(difference.left.as_ref().unwrap().size, 10);
        assert_eq!(difference.right.as_ref().unwrap().size, 20);
    }
}
