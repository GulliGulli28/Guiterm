# Refonte de l'interface — design retenu et plan

Maquettes validées le 2026-10-27. Ce fichier dit **ce qui a été décidé** et
**dans quel ordre on le construit**. Les maquettes elles-mêmes vivent dans le
canevas « Guiterm — Refonte UI »
(https://claude.ai/artifact/EesSNUPmUkFa3RiwAAxLAj) : 23 écrans en avant/après,
8 en thème clair, le système visuel et 7 scénarios mesurés en nombre d'étapes.

Comme `docs/backlog.md`, ce plan a été vérifié dans le code à sa date
d'écriture : **revérifier un levier avant de démarrer une tranche**.

## Pourquoi

L'audit (103 captures : `node scripts/visual-tour.mjs` en sombre et clair,
plus un parcours complémentaire) montre que les freins viennent moins du
visuel que de l'orientation :

- **Navigation muette.** 12 icônes sans libellé dans le rail ; Known Hosts,
  SFTP, Identités AWS ne se devinent pas.
- **Fonctions rangées là où on ne les cherche pas.** L'import de
  `~/.ssh/config` est dans le panneau Known Hosts ; supprimer un hôte n'est
  possible qu'en bas de son formulaire.
- **Gestion coincée dans la barre latérale.** Paramètres (560 px) et GuiVault
  (300 px) s'empilent dans le panneau pendant que la zone principale reste vide.
- **Pavés explicatifs.** 5 à 11 lignes de texte sous un réglage, une alerte ou
  un état vide.
- **Information utile tronquée.** La palette affiche deux fois « Se connecter —
  Production › Frontaux we… » : le nom de l'hôte disparaît.

## Décisions de design

**Une suite avec GuiVault.** Mêmes jetons que le design retenu de GuiVault :
police Geist (interface) et Geist Mono (toute donnée : adresse, port, chemin,
commande, empreinte), surfaces graphite, accent indigo `#8B8CFF` en sombre /
`#5755D9` en clair. Plat, bordures d'un pixel, rayons 7 à 12 px, l'accent
réservé à ce qui agit. Valeurs exactes : `project/theme.css` du canevas.

**Coquille.**
- Les onglets passent **dans la barre de titre** (40 px rendus au contenu),
  avec un onglet Accueil épinglé et, à droite, « Rechercher ou se connecter ·
  Ctrl K » qui ouvre la palette.
- **Rail à libellés** (72 px, icône + mot) en trois groupes. Navigation :
  Hôtes, Fichiers, Snippets, Bases, Tunnels, Clés, Cloud. Outils : Flotte,
  Runbooks, Réseau, Activité. En bas : GuiVault, Réglages, puis l'avatar du
  compte avec une pastille de synchro. La barre de profil quitte le haut des
  panneaux pour le menu de l'avatar.
- **Panneau pour ce qu'on parcourt, page pour ce qu'on gère.** Hôtes, Fichiers,
  Snippets, Bases, Tunnels et les cibles de flotte restent des panneaux.
  Réglages, GuiVault, Clés et empreintes, Cloud et Activité deviennent des
  pages pleine largeur, ouvertes en onglet unique.
- **Barre de session** en tête de chaque terminal : fil d'Ariane (vault ›
  dossier › hôte), état, puis des actions nommées (Fichiers, Snippets,
  Diviser, Diffuser, Coller depuis GuiVault). Elles remplacent les quatre
  icônes muettes de la barre d'onglets. Une barre d'état discrète en bas donne
  la latence, la taille et la méthode d'authentification.

**Listes.** Un hôte tient sur 2 lignes (44 px au lieu de 66) : nom, puis
`user@adresse` en mono, avec la pastille d'état sur l'icône et la jauge RAM à
droite. Les tags passent dans le filtre et le détail. Chaque vault est une
section avec sa couleur. Au survol d'une ligne apparaissent les actions
rapides : terminal, fichiers, menu.

**Voix.**
- Vouvoiement partout : « Sélectionne des cibles » devient « Sélectionnez des
  cibles ».
- Des verbes sur les boutons.
- Une ligne d'aide au plus sous un champ ; le reste dans « En savoir plus ».
- Une erreur dit ce qui s'est passé, puis ce qu'on peut faire, avec le bouton
  qui le fait. Le message brut reste visible en mono.

**Ce qui ne change pas.** Raccourcis, arborescence par vault, palette,
`data-sidebar-button` / `data-sidebar-panel` / `data-focus-zone` (l'E2E et la
navigation clavier s'y accrochent). La refonte réorganise ; elle ne retire
aucune fonction. Une exception assumée : `Alt+1…0` comptent les boutons
visibles du rail, et Known Hosts n'est plus en tête. Depuis la tranche 1,
`Alt+1` ouvre Hôtes, `Alt+2` Fichiers, et `Alt+0` toujours Runbooks.

## À corriger quelle que soit la refonte

Constats de l'audit qui sont des bugs ou des écarts, pas des choix de design :

1. **Formulaire d'un hôte RDP.** Il affiche encore « Ouvre le client RDP du
   système… pour cette première version », alors que le lanceur système a été
   retiré. Il propose aussi « Transférer l'agent SSH », sans objet pour du RDP.
   À corriger dans `HostForm.tsx`.
2. **Connexions de base de données sans dossiers.** Le modèle a déjà
   `SqlConnection.group_id` (`core/src/model.rs`, `#[serde(default)]`), mais
   `SqlConnectionForm.tsx` le force à `null` et `SqlConnectionsPanel.tsx`
   affiche une liste à plat par vault. Il faut l'arborescence vault › dossier ›
   connexion, comme pour les hôtes, via `buildHostTree` ou son équivalent (cf.
   la règle « chaque arbre passe par `buildHostTree` » de `CLAUDE.md`).
   Remarque de l'utilisateur du 2026-10-27 : à ne pas oublier.
3. **Cibles de flotte incomplètes ?** Dans le tour visuel, la liste des cibles
   n'affiche que 4 cibles sur 7 : web-01, web-02, pg-primary et bastion
   manquent. À vérifier avant la tranche 6 : bug de `buildTargetTree` ou effet
   des données factices.
4. **Tutoiement et vouvoiement mélangés** (flotte, runbooks).
5. **Palette.** Le nom de l'hôte est tronqué au profit du chemin du dossier.

## Plan — tranches verticales

Chaque tranche se livre seule : visible, vérifiée (`npm run verify`, tour
visuel sombre **et** clair, E2E, binaire Windows lancé), puis commitée. Le
CHANGELOG s'écrit après le test manuel de chaque tranche.

### Tranche 0 — Fondations visuelles (aucun changement de structure) — **livrée le 2026-10-27**

- **Jetons.** Réécrire les valeurs de `:root` et `:root[data-mode="light"]`
  dans `src/index.css` vers la palette retenue, **sans renommer les variables
  `--c-*`** : tous les composants suivent d'un coup. Ajouter les jetons
  manquants : surfaces `raised`, versions douces des états, rayons.
- **Polices.** Geist et Geist Mono embarquées via Fontsource, comme les
  polices actuelles (`@fontsource/*` dans `package.json`, nom exact du paquet
  à confirmer à l'installation). Jamais de CDN : Tauri sert `dist/` hors
  ligne. Ajouter Geist Mono au choix de police du terminal.
- **Préférences.** `src/lib/preferences.ts` : nouveaux défauts
  (`uiAccent: "indigo"`, fond graphite). **Piège connu** : un défaut ne
  s'applique pas à une installation existante (localStorage). Il faut une
  migration unique, versionnée, qui ne remplace que les valeurs encore égales
  aux anciens défauts.
- **Primitives.** `.btn` (tailles sm/md/lg), `.chip`, `.tag`, `.callout`,
  `.card`, `.seg`, `.switch`, `.kbd`, alignées sur `theme.css`.
- **Outillage.** Intégrer à `scripts/visual-tour.mjs` les scènes du parcours
  complémentaire de l'audit : premier lancement, SQL, Redis, résultats de
  flotte, double authentification, déverrouillage, échec de connexion, toutes
  les catégories des Paramètres. Ces scènes ont été prototypées dans
  `scripts/.output/ui-audit.mjs`, non versionné. Elles reposent sur un
  émetteur d'événements factice (`window.__emit`) posé autour de la couche
  Tauri du tour.
- **Garde-fou.** `accessibility.test.ts` et `focusIndication.test.ts` doivent
  rester verts. Contrôler à l'œil les contrastes du thème clair.

### Tranche 1 — Coquille — **livrée le 2026-10-27**

Écarts avec le plan : la barre d'état en bas du terminal (latence, taille)
est remise à plus tard, faute de mesure de latence côté Rust. Activité
entre dans le rail sans numéro `Alt+n`, car ce n'est pas un panneau.

- **Frontend.**
  - `TitleBar.tsx` + `TabBar.tsx` : onglets dans la barre de titre, zones
    `data-tauri-drag-region`, bouton de recherche, cloche.
  - `Sidebar.tsx` : rail à libellés et groupes.
  - `lib/sidebarButtons.ts` : nouveaux libellés (« SFTP » → « Fichiers »,
    « Identités AWS » → « Cloud », « Diagnostic réseau » → « Réseau »,
    « Opérations de flotte » → « Flotte »). Les ids ne changent pas.
  - `ProfileBar.tsx` devient le menu de l'avatar.
  - `TerminalTab.tsx` / `LocalTerminalTab.tsx` : barre de session et barre
    d'état. Les actions viennent de la barre d'onglets ; `BroadcastBar.tsx`
    devient le bandeau « Ce que vous tapez part vers… ».
  - `App.tsx` : disposition générale.
- **Backend.** Aucun.
- **Garde-fous.**
  - `sidebarButtons.test.ts`, `keyboardNav.test.ts` (`sidebarButtonAt`),
    `shortcuts.test.ts`.
  - Sélecteurs E2E de `scripts/e2e-run.mjs` : `data-sidebar-button`,
    `data-sidebar-panel`, `.modal button[aria-label="Fermer"]` et le piège du
    bouton Fermer de la barre de titre.
  - Le scénario plein écran.
- **Vérifier sous WebView2** : glisser la fenêtre par la barre de titre,
  double-clic pour agrandir, onglets nombreux dans une fenêtre étroite.

### Tranche 2 — Hôtes — **livrée le 2026-10-27**

Écarts avec le plan :
- Un clic simple connecte toujours. Le double-clic n'a pas été retenu, car
  il aurait ralenti l'action la plus fréquente de l'app.
- Pas d'« Ouvrir à côté » : l'ouverture en split passe toujours par la
  barre de session.
- La palette groupe Hôtes / Actions / Panneaux, sans groupe Snippets : les
  snippets passent par `Ctrl+Shift+R`, qui a sa propre liste.
- Les tags et l'OS d'un hôte sont passés dans l'infobulle de la ligne,
  qui affiche maintenant `utilisateur@adresse`.
- Le menu du compte (tranche 1) est rendu dans un portail, à droite du
  rail : il passait sous le panneau. La scène `41` du tour vérifie qu'aucun
  point du menu n'est recouvert.

Le contenu prévu :

- **Frontend.**
  - `EntityRow.tsx`, `HostsPanel.tsx` : lignes sur 2 lignes, actions au survol,
    double-clic pour connecter.
  - `ContextMenu.tsx` + le menu d'hôte : Ouvrir un terminal, Ouvrir les
    fichiers, Ouvrir à côté, Modifier, Dupliquer, Copier la commande ssh,
    Tester la joignabilité, Sessions tmux, Déplacer vers un vault, Exporter,
    Supprimer (avec confirmation).
  - `CommandPalette.tsx` : nom en premier, chemin en second, groupes Hôtes /
    Snippets / Actions, pied de page de raccourcis.
- **Backend.** `duplicate_host` dans `core` + `commands/hosts.rs` + `api.ts` :
  la copie doit dupliquer les secrets du coffre sous le nouvel id, ce que le
  frontend ne peut pas faire seul.
- **Garde-fous.**
  - `hostTree.test.ts`, `hostPickers.test.ts`.
  - Un test sur l'inventaire des actions du menu d'hôte : chaque action
    attendue est présente.
  - Le scénario E2E du menu « Options ».

### Tranche 3 — Accueil, premier lancement, import unifié

**Livrée le 2026-10-28** (3a/3b : accueil et premier lancement ; 3c : import
unifié et snippets fréquents). Ce qui a été fait, et les écarts avec le plan :
- `HomePage.tsx` n'est pas un onglet. Il s'affiche sans onglet ouvert, et le
  logo de la barre de titre (`data-home-button`) le rouvre par-dessus les
  onglets, qui restent montés. Choisir un onglet le referme. Un onglet
  « Accueil » aurait demandé un `kind` de plus dans tous les dispatches,
  pour un écran qui n'a pas d'état à garder.
- Récents : `lib/recents.ts`, en `localStorage`
  (`gui-termius-recents`). Ils sont alimentés à la réussite d'une connexion
  (`onConnected` de `TerminalTab`, `useConnectedSignal` des trois onglets
  de base). Seul l'aperçu RDP compte dès l'ouverture : il ne signale pas sa
  connexion.
- « Sessions à reprendre » : aucune commande ne liste les sessions tmux de
  tous les hôtes sans passer par le réseau. Les récents retiennent donc la
  clé de session de chaque connexion persistante, et l'accueil propose
  celles qu'aucun onglet n'affiche. « Masquer » oublie la clé, sans tuer
  la session.
- « Snippets fréquents » (3c) : `lib/snippetUsage.ts`, en `localStorage`
  (`gui-termius-snippet-usage`), local comme les récents. Chaque exécution
  compte (panneau Snippets, `Ctrl+Shift+R`, accueil) ; le classement est une
  fréquence amortie (demi-vie de 14 jours), pas un compteur brut. Un clic
  lance le snippet dans le terminal resté sous l'accueil ; ses variables
  passent par le sélecteur, ouvert directement dessus. Sans terminal, la
  ligne est inactive. Écart : pas de raccourci clavier par snippet comme sur
  la maquette (« Ctrl ⇧ 1 ») — les snippets n'en ont pas ; la ligne montre la
  commande à la place.
- **Import unifié (3c)** : `ImportHostsDialog` (`lib/importSources.ts`), six
  sources — `~/.ssh/config`, AWS, Google Cloud, Azure, inventaire Ansible,
  fichier d'export Guiterm. La colonne de gauche dit où en est chaque source
  avant qu'on la choisisse (hôtes à importer, `gcloud` connecté, `az`
  introuvable…). Les panneaux de chaque source perdent leur modale et
  passent dans `ImportSourceFrame` ; `CloudProviderPicker` disparaît. Une
  seule entrée « Importer des hôtes… » dans le menu « Ajouter… » ; l'accueil
  et Known Hosts ouvrent la même fenêtre sur la bonne source.
- La source `~/.ssh/config` devient un tableau (alias, adresse, utilisateur,
  « passe par », état), avec un filtre et « Ranger dans » (dossier).
  Écart : pas de choix du vault à l'import, ni de « nouveau dossier »
  créé à la volée — on range dans un dossier existant, puis « Déplacer
  vers ».
- La source « Fichier » montre un **aperçu** avant d'importer : nouvelle
  commande `inspect_import_file` (`core::export::preview`), qui reconnaît
  un export de configuration ou d'hôte seul, liste ses hôtes et marque ceux
  qui remplaceraient un hôte existant. « Importer un hôte (fichier) »
  importait auparavant sans rien montrer.
- `useModalSurface` laisse Échap et Tab à une boîte posée par-dessus qui a le
  focus (panneau SSO, connexion Azure, ouverts depuis l'import) : Échap y
  fermait la fenêtre du dessous.
- Garde-fous : scènes `01`, `02b`, `02c`, `09b`, `18`, `18b`, `60`, `60b` du
  tour, avec assertions ; scénarios E2E `runHomeScenario`,
  `runImportFileScenario`, et les scénarios d'import AWS, Ansible, Azure/GCP
  repassés par la fenêtre unifiée ; `recents.test.ts`,
  `snippetUsage.test.ts`, `importSources.test.ts`, tests de
  `core::export::preview`.

Le plan d'origine :

- **Frontend.**
  - Nouveau `HomePage.tsx` (l'onglet Accueil remplace « Aucun onglet ouvert ») :
    connexion rapide, récents, sessions tmux détachées, tunnels actifs, alertes
    (retour en arrière GuiVault, expiration AWS SSO).
  - Variante premier lancement : « N hôtes trouvés dans ~/.ssh/config » via
    `preview_ssh_config_import`.
  - `ImportHostsDialog.tsx` : une fenêtre, des sources (`~/.ssh/config`, AWS,
    Google Cloud, Azure, Ansible, fichier), un aperçu. Il recompose
    `KnownHostsPanel` (import ssh config), `CloudProviderPicker`,
    `AwsImportPanel`, `GcpImportPanel`, `AzureImportPanel`,
    `AnsibleImportPanel` et l'import de fichier.
- **Récents.** Liste locale à l'appareil (préférences), alimentée à chaque
  connexion réussie. Pas de synchro : c'est un usage, pas une donnée.
- **Backend.** Aucun a priori. Vérifier que les commandes existantes suffisent
  pour les sessions tmux à reprendre (clés retenues par les onglets).
- **Garde-fous.** Scène du tour « premier lancement » avec workspace vide ;
  scénario E2E qui ouvre l'import depuis l'accueil.

### Tranche 4 — Formulaire d'hôte

- **Frontend.**
  - `HostForm.tsx` (1007 lignes) découpé en sections : Connexion,
    Authentification, Réseau, Session, Organisation, avec un résumé par section
    dans la navigation du tiroir.
  - Champs selon le type : rien d'agent SSH pour RDP, correction du texte RDP.
  - « Équivalent en ligne de commande » copiable.
  - Même découpage pour `GroupForm.tsx` et `SqlConnectionForm.tsx`, qui gagne le
    champ Dossier.
- **Backend.** `test_host_connection` : une connexion d'essai à partir d'un
  hôte **non enregistré**, sans passer par le pool persistant ni écrire le
  workspace. Elle renvoie la durée, l'empreinte (connue ou nouvelle) et
  l'étape d'échec.
- **Garde-fous.** Les tests de formulaire existants. Le scénario E2E de
  création d'hôte doit trouver ses champs dans la bonne section.

### Tranche 5 — Pages pleine largeur

- **Frontend.**
  - Nouveaux `kind` d'onglet « page », un par page, chacun singleton.
  - `modules/settings.tsx` : `SettingsPanel.tsx` devient une page avec
    recherche ; une ligne par réglage, `SshAgentSettings` et `VaultSettings`
    réintégrés.
  - `modules/guivault.tsx` : `GuiVaultPanel.tsx` devient la page compte (vaults
    en cartes, invitations, alerte compacte), et le vault une sous-page avec
    les onglets Contenu, Membres et Sécurité (`VaultEntityTree.tsx` réutilisé).
  - `modules/keychain.tsx` + `modules/knownHosts.tsx` fusionnent dans la page
    Clés et empreintes.
  - `modules/aws.tsx` devient Cloud.
  - `ActivityTab.tsx` passe en tableau.
- **Ce que ça touche.**
  - `lib/types.ts` (`TabMeta`) et `tabPersistence.ts` : restaurer une page.
  - Le registre : `_EveryTabKindHasAModule` couvre les nouveaux `kind`, et
    `registry.test.ts` / `objects.test.ts` restent verts.
  - `App.tsx` : `toggleSettings` et la largeur 600 px forcée pour le panneau
    Paramètres disparaissent.
- **Backend.** Aucun.
- **Garde-fous.**
  - Scénarios E2E qui attendent `data-sidebar-panel="settings"` : il faut les
    réécrire vers la page, sans perdre ce qu'ils vérifient (zone de focus,
    `Ctrl+,`, `Alt+2`).
  - `assertNever` sur le nouveau dispatch.

### Tranche 6 — Outils

- **Frontend.**
  - `FleetTab.tsx` : résultats visibles et regroupés quand la sortie et le code
    sont identiques, échecs en tête, « Relancer les échecs ».
  - `RunbookTab.tsx` : étapes en frise, approbation dans l'étape.
    `RunbookApprovalModal` reste pour une approbation demandée pendant que
    l'onglet n'est pas visible.
  - `NetDiagTab.tsx` : la matrice existe déjà ; ajouter la phrase de
    conclusion et le détail en panneau latéral.
- **Backend.**
  - Échec de connexion **par étape** : classer l'erreur dans `core` (nom,
    bastion, port, poignée de main, authentification) en type structuré.
    `ConnectionFailed.tsx` affiche l'étape et propose « Tester depuis
    d'autres hôtes », pré-rempli dans le diagnostic réseau. Messages en
    français : `error_messages_are_french.rs`.
  - Vérifier d'abord le point 3 des constats (cibles de flotte).

### Tranche 7 — Données et bibliothèque

- **Frontend.**
  - `SqlConnectionsPanel.tsx` : **arborescence vault › dossier › connexion**
    (constat 2), pastille « ouvert ».
  - `SqlTab.tsx` : plusieurs requêtes en onglets, temps d'exécution et nombre
    de lignes, colonnes typées, export CSV en un clic. `RedisTab` et `MongoTab`
    suivent la même mise en page.
  - `TunnelsPanel.tsx` : un tunnel se lit comme une phrase, avec un
    interrupteur ; formulaire en page avec schéma Local / Distant / SOCKS et
    champs libellés.
  - `SnippetsPanel.tsx` / `SnippetPicker.tsx` : liste dense, carte d'exécution
    ancrée au terminal, variables `{{…}}` remplies dans un mini-formulaire.
  - `TransferTab.tsx` : fil d'Ariane, sélection au clic, file de transferts
    en bas.
- **Backend.** Aucun : `group_id` existe déjà côté Rust.
- **Garde-fous.**
  - `SqlConnectionTab.test.ts`, `SqlTab.history.test.ts`.
  - `npm run check:transfer` : colonnes et glisser-déposer.
  - Un test qui vérifie qu'une connexion rangée dans un dossier apparaît sous
    ce dossier.

### Tranche 8 — Dialogues et sécurité

- **Frontend.**
  - `SshAuthPromptModal.tsx` : contexte (bastion → hôte), code en 6 cases quand
    l'invite ressemble à un code, remplissage depuis GuiVault quand un TOTP
    correspond à l'hôte.
  - `SshAgentConfirmModal.tsx` restylé.
  - `VaultUnlockModal.tsx` devient un écran de verrouillage : ce qui est fermé,
    ce qui reste disponible.
- **Backend.** Retrouver le TOTP GuiVault d'un hôte : passer par
  `guivault_browse` / `guivault_browse_totp`, existants, avec une règle de
  correspondance à définir (nom, adresse).

### Tranche 9 — Finitions

- Passe complète sur les textes : vouvoiement, paragraphes réduits à une ligne
  plus une infobulle.
- Thème clair revu écran par écran.
- CHANGELOG de la refonte, écrit après le test manuel Windows.
- Mise à jour de `CLAUDE.md`, section « langage visuel ».

## Écarts avec la maquette — pistes pour la suite

Ce que les maquettes des écrans **déjà livrés** (tranches 0 à 3) montrent et
que l'app ne fait pas encore. Inventaire fait le 2026-10-28 en relisant les
planches du canevas (`Accueil`, `Import`, `Terminal`, `MenuHote`, `Palette`,
`PremierLancement`) contre le code. Les tranches 4 à 9 ne sont pas encore
comparées : leurs écarts s'ajouteront ici à leur livraison.

C'est une réserve de fonctionnalités, pas une liste de dettes. Chaque ligne
dit ce que montre la maquette, ce qui existe aujourd'hui, et ce qu'il faudrait
pour combler l'écart. Comme le reste de ce fichier, **revérifier dans le code
avant de démarrer** : une ligne a pu être comblée en passant.

Taille : **S** = frontend seul, une demi-journée ; **M** = un composant de
plus ou une commande Rust simple ; **L** = une commande réseau, un nouvel état
partagé, ou une décision de design à prendre d'abord.

### À traiter en premier

| Écart | Aujourd'hui | Ce qu'il faudrait | Taille |
|---|---|---|---|
| **L'import de `~/.ssh/config` perd les bastions et les clés.** L'accueil promet « vos alias, utilisateurs, ports et bastions, tels quels », et la colonne « Passe par » de l'import affiche le `ProxyJump`. | `import_ssh_config_hosts` (`commands/known_hosts.rs`) ne reprend que l'adresse, l'utilisateur, le port et `ProxyCommand`. `ProxyJump` et `IdentityFile` sont lus par `core::ssh_config` puis ignorés : l'hôte importé tente une connexion directe. | Résoudre `ProxyJump` vers un hôte existant ou importé dans le même lot (par alias), et le poser en `jump_via`. Reprendre `IdentityFile` en clé privée par chemin. Test dans `core` sur un `config` écrit à la main, avec un bastion importé dans le même lot. | M |

### Coquille et terminal (tranche 1)

| Écart | Aujourd'hui | Ce qu'il faudrait | Taille |
|---|---|---|---|
| **Barre d'état du terminal** : méthode d'authentification (« Clé ed25519 via l'agent »), OS, latence, taille de la grille, encodage, aide des suggestions. | Absente. Remise à plus tard à la tranche 1, faute de mesure de latence. | En deux temps. Frontend seul : taille (xterm), OS (faits déjà collectés), encodage, aide des suggestions. Backend : la méthode qui a réussi est connue de `ssh::authenticate` et peut remonter dans `TerminalOpened` ; la latence demande un aller-retour mesuré sur la connexion (keepalive). | S puis M |
| **État dans la barre de session** (« actif », reconnexion). Le plan disait : fil d'Ariane, état, actions. | Fil d'Ariane et actions seulement. | Une pastille et un mot, lus de l'état que `TerminalTab` connaît déjà (connecté, reconnexion, coupé). | S |
| **Onglets parlants** : pastille d'état par onglet, puce `tmux`, icône de diffusion active. | Icône du genre d'onglet et couleur de l'hôte ; persistant et observation dans l'infobulle seulement. | Rendre ces trois états dans `TabBar`, à partir de `TabMeta` (`sessionKey`, statut) et de l'état de diffusion d'`App`. | S |
| **Pastille sur GuiVault dans le rail** quand un vault est revenu en arrière (rouge sur la maquette). | Seul Cloud porte une pastille (session SSO qui expire). | La même pastille sur GuiVault, depuis `guivaultStatus.rollbacks`. | S |
| **En-tête de volet en écran divisé** (« web-01 · actif », volet actif encadré d'accent). | Pas d'en-tête nommant chaque volet. | Une ligne de 28 px par volet dans la vue divisée. | S |

### Hôtes (tranche 2)

| Écart | Aujourd'hui | Ce qu'il faudrait | Taille |
|---|---|---|---|
| **En-tête du panneau** : bouton icône « Importer des hôtes », bouton « Nouveau » direct, sélection multiple, et `/` pour filtrer. | Un bouton « Ajouter… » qui ouvre un menu. La sélection multiple existe, à côté. | Réorganiser l'en-tête de `HostsPanel` ; brancher `/` sur la recherche du panneau (à ajouter dans `lib/shortcuts.ts`, en vérifiant `shellBindingWarning` : `/` ne doit pas partir d'un terminal). | S |
| **Raccourcis du menu d'hôte**, affichés et actifs : Entrée (terminal), Ctrl+Entrée (fichiers), F2 (modifier), Ctrl+D (dupliquer), Suppr. | Le menu existe sans raccourcis. | Les gérer sur la ligne qui a le focus (`useRowNavigation`), et les afficher en `.kbd` dans le menu. | M |
| **En-tête du menu** avec la jauge RAM de l'hôte. | Nom et commande ssh. | Reprendre la jauge de la ligne. | S |
| **« Sessions tmux · 1 détachée »** : le nombre de sessions dans l'entrée de menu. | L'entrée ouvre le gestionnaire, sans compte. | Compter les clés retenues par les récents (`lib/recents.ts`) pour cet hôte. Le vrai nombre demanderait le réseau. | S |
| **« Ouvrir à côté de *onglet actif* »** depuis le menu d'hôte. | Écarté à la tranche 2 : la division passe par la barre de session. | À rouvrir si l'usage le demande : ouvrir l'hôte dans le volet droit de l'onglet actif. | M |
| **« Déplacer vers › Cet appareil seulement »** : sortir un hôte de GuiVault. | « Déplacer vers » ne liste que les vaults du compte. | Ajouter la destination `local` : `transfer::Place::Local` existe déjà dans `guivault_transfer_entities`. | S |

### Palette (tranche 2)

| Écart | Aujourd'hui | Ce qu'il faudrait | Taille |
|---|---|---|---|
| **Groupe Snippets**, avec « dans *onglet actif* ». | Pas de groupe Snippets : ils passent par `Ctrl+Shift+R`. | Ajouter le groupe, trié par `lib/snippetUsage.ts` (le classement existe depuis la 3c). Les variables passent par `SnippetPicker` (`initialSnippet`). | S |
| **Correspondance surlignée** (`<mark>`). | Non surlignée. | Découper le libellé autour de la correspondance. | S |
| **« Ouvert »** sur un hôte déjà en onglet ; Entrée va à l'onglet au lieu d'en ouvrir un second. | Entrée ouvre un nouvel onglet. | Les cibles ouvertes sont déjà calculées pour l'accueil (`openTargets` dans `App`). | S |
| **Actions secondaires au clavier** : Ctrl+Entrée (fichiers), Tab (plus d'actions), `>` (commandes seules), filtre de portée « Tout ». | Entrée seulement. | Un second niveau d'actions par résultat dans `CommandPalette`, et un mode « commandes ». | M |
| **Action composée** : « Ouvrir web-01 et web-02 côte à côte, en diffusion ». | Il faut ouvrir, diviser puis diffuser à la main. | Une action de palette proposée quand la recherche désigne deux hôtes, qui enchaîne les trois. | M |

### Accueil (tranche 3)

| Écart | Aujourd'hui | Ce qu'il faudrait | Taille |
|---|---|---|---|
| **Raccourci par snippet** (« Ctrl ⇧ 1 », « Ctrl ⇧ 2 »). | Les snippets n'ont pas de raccourci ; la ligne montre la commande. | Un raccourci assignable par snippet. Le garder **local au poste** (préférences) plutôt que dans le `Snippet` synchronisé : deux postes n'ont pas les mêmes mains. Vérifier les collisions avec `shellBindingWarning`. | M |
| **Tunnels avec interrupteur** dans « En cours », y compris un tunnel arrêté. | La section « Tunnels actifs » n'affiche que ceux qui tournent, sans action. | Lister aussi les tunnels arrêtés récemment utilisés, avec un `switch` qui démarre ou arrête (commandes existantes du panneau Tunnels). | S |
| **Transferts en cours** dans « En cours » : fichier, pourcentage, débit, temps restant. | Les transferts ne sont visibles que dans leur onglet. | Un état global des transferts : `TransferProgressEvent` existe, mais n'est écouté que par `TransferTab`. | M |
| **Ce qui tourne dans une session à reprendre** (« `htop` en cours ») et l'heure réelle du détachement. | « Détachée · il y a 2 h », d'après la dernière connexion retenue. | Une commande qui interroge tmux sur l'hôte (`#{pane_current_command}`, `#{session_activity}`), à la demande, puisque c'est un aller sur le réseau. | M |
| **Sessions découvertes sur l'hôte**, même ouvertes depuis un autre poste. | L'accueil ne propose que les sessions dont ce poste a retenu la clé. | Interroger les hôtes à sessions persistantes au chargement de l'accueil : borné, en parallèle, sans bloquer l'affichage. Décider d'abord si l'accueil a le droit d'ouvrir des connexions de lui-même. | L |

### Import (tranche 3c)

| Écart | Aujourd'hui | Ce qu'il faudrait | Taille |
|---|---|---|---|
| **Choix du vault à l'import** (« Ranger dans *Personnel* ▾ »). | Les hôtes importés arrivent dans le workspace affiché ; on les range ensuite avec « Déplacer vers ». | Un `VaultField` dans le pied de la fenêtre, puis `guivault_transfer_entities` sur les ids créés (les commandes d'import rendent le workspace : comparer les ids avant et après). | M |
| **« Nouveau dossier « ssh config » »** créé à la volée. | On choisit un dossier existant. | Une entrée « Nouveau dossier… » dans `GroupTreePicker`, qui crée le groupe avant l'import. Utile aussi au formulaire d'hôte. | S |
| **Un pied de fenêtre commun** (« Ranger dans » + bouton Importer) pour toutes les sources. | Chaque source a le sien ; AWS range par tag, Azure et GCP ont « Groupe de destination » dans leurs identifiants. | Remonter la destination dans `ImportHostsDialog` et la passer aux sources. Garder dans chaque source ce qui lui est propre (identifiants du lot, dossier depuis un tag AWS). | M |

### Écarts assumés, à ne pas rattraper

Des choix faits en connaissance de cause. Ils sont listés ici pour qu'une
relecture de la maquette ne les reprenne pas comme des oublis :

- **Un clic simple connecte** (la maquette du plan disait double-clic) : c'est
  l'action la plus fréquente de l'app (tranche 2).
- **L'accueil n'est pas un onglet** : un `kind` de plus dans tous les
  dispatches, pour un écran sans état à garder (tranche 3).
- **Les tags et l'OS d'un hôte sont dans l'infobulle**, pas sur la ligne : la
  ligne reste à deux lignes (tranche 2).
- **Activité n'a pas de numéro `Alt+n`** : ce n'est pas un panneau (tranche 1).

## Hors périmètre, dit d'avance

- **Déverrouillage Windows Hello.** Montré sur la maquette du coffre
  verrouillé, mais il demande l'API Windows et une décision de sécurité sur la
  clé maître. À traiter comme une fonctionnalité à part.
- **Couleur propre à Guiterm.** L'indigo est partagé avec GuiVault. L'autre
  option est le bleu-cyan du logo, à décider avant la tranche 0 si on la
  veut.
- **Mobile, extension.** Sans objet pour Guiterm.
