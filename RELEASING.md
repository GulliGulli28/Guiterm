# Publier une release

L'app se met à jour toute seule (bouton "Vérifier les mises à jour" dans
Paramètres > Général, plus une vérification silencieuse au lancement) via
GitHub Releases. Ce document décrit comment déclencher une nouvelle version.

## Vue d'ensemble

1. `.github/workflows/release.yml` construit les installeurs (Windows, Linux,
   macOS Apple Silicon et Intel — un job par plateforme) et publie une
   **release brouillon** à chaque tag `v*` poussé sur GitHub.
2. Tant que la release reste en brouillon, elle est invisible pour
   l'updater (et pour la page "latest release" de GitHub) — c'est un choix
   délibéré : ça laisse le temps de vérifier que le build est sain avant
   qu'il ne soit proposé à qui que ce soit.
3. Publier le brouillon manuellement est ce qui rend la mise à jour réelle.

## Étapes

```bash
# 1. Bumper la version (package.json + Cargo.toml en une commande ;
#    tauri.conf.json n'a volontairement pas de champ "version" — Tauri lit
#    celle de src-tauri/Cargo.toml, qui hérite elle-même du workspace).
npm run bump-version -- 1.4.1

# 2. Commit + push
git add -A && git commit -m "Bump version to 1.4.1"
git push

# 3. Tag + push du tag : déclenche le build
git tag v1.4.1
git push origin v1.4.1
```

4. Suivre l'avancement dans l'onglet **Actions** du dépôt (~10-15 min pour
   un build Windows natif). **Vérifier que les quatre jobs sont verts avant
   de publier** : ils s'ajoutent à la même release brouillon au fur et à
   mesure, donc un job annulé ou en échec ne se voit pas dans la release —
   il se voit à un installeur manquant. C'est ce qui est arrivé à la 2.4.0 :
   le job `macos-13` (Intel) n'a jamais obtenu de runner et a été annulé, la
   release est partie avec le seul `.dmg` Apple Silicon.
5. Une fois le run vert, ouvrir **Releases**, ouvrir le brouillon `v1.4.1`,
   vérifier les notes puis cliquer **Publish release**.
6. Les installations existantes verront la mise à jour au prochain
   lancement, ou immédiatement via "Vérifier les mises à jour".

## En cas d'erreur de build

- Voir le log de l'étape en échec dans Actions (nécessite d'être connecté :
  l'API publique ne permet pas de télécharger les logs sans jeton).
- Si le tag pointe déjà vers un commit dont le build a échoué, corriger le
  problème sur `master`, committer, puis redéplacer le tag :
  ```bash
  git tag -f v1.4.1
  git push --force origin v1.4.1
  ```

## Clé de signature de l'updater

Les artefacts sont signés (obligatoire pour que l'updater les accepte) avec
une clé générée via `tauri signer generate`. La clé privée vit dans le
secret GitHub Actions `TAURI_SIGNING_PRIVATE_KEY` (+ éventuellement
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` si elle est protégée par un mot de
passe) — jamais dans le dépôt. La clé publique correspondante est dans
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

**Si la clé privée est perdue**, il devient impossible de signer de
nouvelles releases que les installations existantes accepteront : il
faudrait redistribuer l'app avec une nouvelle clé publique. Gardez une
copie de la clé privée en lieu sûr (gestionnaire de mots de passe, coffre).

## Signature par le système d'exploitation — câblée, pas encore active

À ne pas confondre avec la clé ci-dessus : celle-ci ne concerne que
l'updater interne. Vis-à-vis de Windows et de macOS, les binaires publiés
sont **non signés**, avec des conséquences visibles pour qui les installe :

- **Windows** : SmartScreen affiche « Windows a protégé votre ordinateur »
  au premier lancement de chaque nouvelle version. L'utilisateur doit passer
  par « Informations complémentaires » → « Exécuter quand même ».
- **macOS** : Gatekeeper refuse d'ouvrir l'app avec le message le plus
  alarmant de son répertoire — « L'application "Guiterm" est endommagée et
  ne peut pas être ouverte. Vous devriez la placer dans la corbeille. »
  C'est bien celui des apps **non signées** mises en quarantaine, et non
  « impossible de vérifier le développeur » (ce dernier concerne une app
  signée mais non notarisée, et propose au moins « Ouvrir quand même »).
  Remonté par un utilisateur sur la 2.4.0, [issue
  #27](https://github.com/GulliGulli28/Guiterm/issues/27) — le seul
  binaire macOS publié ne contient d'ailleurs que la signature ad-hoc que le
  linker pose sur tout binaire arm64, aucun `Contents/_CodeSignature/`.
  Contournements à donner aux utilisateurs :
  `xattr -dr com.apple.quarantine /Applications/Guiterm.app`, ou Réglages
  système → Confidentialité et sécurité → « Ouvrir quand même ». Le clic
  droit → Ouvrir, qu'on trouve encore partout, ne fonctionne plus depuis
  macOS 15.

Pour un client SSH — qui manipule des mots de passe et des clés privées —
c'est le premier frein à l'adoption : l'avertissement dit littéralement à
l'utilisateur de se méfier du logiciel auquel il s'apprête à confier ses
accès. Les options, par coût croissant :

| Piste | Coût | Remarque |
|---|---|---|
| [SignPath Foundation](https://signpath.org/) | gratuit | Réservé aux projets open source. Guiterm est MIT, donc a priori éligible. Windows uniquement. |
| Azure Trusted Signing | ~10 $/mois | Nécessite une entité légale avec 3 ans d'ancienneté vérifiable. Windows uniquement. |
| Certificat OV classique | ~200-400 €/an | Réduit l'avertissement sans le supprimer tant que la réputation SmartScreen n'est pas établie. |
| Certificat EV | ~400-600 €/an | Confiance SmartScreen immédiate. Token matériel, donc peu commode en CI. |
| Apple Developer Program | 99 $/an | Nécessaire pour signer **et** notariser côté macOS. |

### Ce que le workflow fait déjà

`release.yml` a une étape « Export Apple signing credentials » qui exporte
les variables lues par `tauri-bundler`, **uniquement si le secret
`APPLE_CERTIFICATE` existe et n'est pas vide**. Tant qu'il n'existe pas, le
build macOS se déroule comme aujourd'hui (non signé) et le job affiche un
avertissement dans le résumé du run.

Il fallait bien une étape dédiée, contrairement à ce qui était écrit ici
avant : un simple bloc `env:` sur l'étape de build ne suffit pas. Un secret
GitHub inexistant produit quand même une variable d'environnement **définie
mais vide**, or `tauri-bundler` ne teste que la présence
(`var_os("APPLE_CERTIFICATE")`, cf. son `macos/sign.rs`) — il aurait donc
essayé d'importer un `.p12` vide et cassé tous les builds macOS d'ici là.

### Ce qu'il restera à faire, le jour où le compte Apple existe

1. Créer un certificat **Developer ID Application** — pas « Apple
   Development », qui ne permet pas la distribution hors App Store —, puis
   l'exporter en `.p12` protégé par un mot de passe.
2. `base64 -i certificat.p12 | pbcopy` pour obtenir la valeur du secret.
3. Créer un **mot de passe pour application** sur appleid.apple.com : le mot
   de passe du compte Apple lui-même ne fonctionne pas pour `notarytool`.
4. Ajouter ces secrets dans Settings → Secrets and variables → Actions :

| Secret | Valeur | Ce qui se passe sans lui |
|---|---|---|
| `APPLE_CERTIFICATE` | le `.p12` encodé en base64 | rien n'est signé (état actuel) |
| `APPLE_CERTIFICATE_PASSWORD` | mot de passe du `.p12` | idem : le certificat n'est pas importé |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Nom (TEAMID)` | facultatif — l'identité du certificat importé est utilisée |
| `APPLE_ID` | e-mail du compte Apple Developer | app signée mais **non notarisée** → Gatekeeper refuse toujours |
| `APPLE_PASSWORD` | le mot de passe pour application de l'étape 3 | idem |
| `APPLE_TEAM_ID` | identifiant d'équipe (10 caractères) | échec de build volontairement bruyant (`MissingTeamId`) |

5. Retagger une version, puis vérifier sur un vrai Mac :
   `codesign -dv --verbose=4 /Applications/Guiterm.app` doit montrer une
   autorité « Developer ID Application », et `spctl -a -vvv
   /Applications/Guiterm.app` doit répondre `accepted` /
   `source=Notarized Developer ID`.

Le sidecar RDP n'a besoin d'aucun traitement particulier : `tauri-bundler`
signe les binaires externes du bundle avant l'app elle-même (« inside out »,
comme l'exige Apple) et applique le hardened runtime aux exécutables, lui
aussi nécessaire à la notarisation.

En attendant, le plus utile est de **le dire dans les notes de release** et
dans le README (section « macOS ») plutôt que de laisser l'utilisateur
découvrir l'avertissement seul.
