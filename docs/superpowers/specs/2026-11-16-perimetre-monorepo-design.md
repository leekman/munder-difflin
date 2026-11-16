# Périmètre monorepo : une équipe par sélection de sous-projets

Date : 2026-11-16 — fork perso. Suite de `2026-11-09-etage-projet-et-equipe-design.md` (étage = repo,
« Composer l'équipe »).

## Pourquoi

L'utilisateur travaille dans le monorepo GlobalExam (`~/code/globalexam`, ~40 projets sous
`packages/<catégorie>/<projet>`, par ex. `packages/services/live.global-exam.com`,
`packages/services/core.global-exam.com`, `packages/sdk/php`). Aujourd'hui un étage est normalisé à la
racine git (`normalizeFloorRepo` → `mainRepoRoot`), donc « Composer l'équipe » analyse tout le monorepo et
produit une équipe générique, un seul roster pour tout le monorepo.

Il veut **s'adapter au projet dans le projet** : dire « cette semaine je bosse sur live + core », obtenir une
armée d'agents taillée pour ces sous-projets, et pouvoir changer de sélection plus tard. En revenant à une
sélection déjà utilisée, il veut **retrouver l'équipe d'avant** (avec un petit résumé) **ou repartir de zéro**.

Succès : sur l'étage `globalexam`, cocher `live` et `core`, composer → des agents dont les missions citent
les vrais chemins de ces deux projets et qui démarrent dans leur sous-dossier. Passer à `sdk/php` → l'équipe
live+core est mise de côté (rien de perdu). Revenir à live+core → « Reprendre » ramène les mêmes agents avec
leur conversation.

## Objectifs

- Un **mode monorepo** par étage, avec une **liste des sous-projets** détectés et cochables (1 ou plusieurs).
- La sélection cochée = le **périmètre** de l'étage. « Composer l'équipe » n'analyse que ce périmètre.
- **Une équipe mémorisée par périmètre.** Changer de périmètre met l'équipe courante de côté ; revenir à un
  périmètre connu propose « Reprendre cette équipe » (avec résumé) ou « Repartir de zéro ».
- Les agents d'un sous-projet **démarrent dans son dossier** (y compris en worktree isolé).

## Non-objectifs

- Pas de lecture des fichiers de workspaces (pnpm, turbo, nx, lerna) : le monorepo GlobalExam n'en a pas ;
  la détection par manifestes suffit.
- Pas d'étage séparé par périmètre (approche B écartée) : un étage reste = un repo, une fenêtre.
- Pas de multi-repo dans un étage.
- Pas de changement du god / orchestrateur.

## Anti-objectifs (échec même si « ça marche »)

- Perdre un agent ou sa conversation en changeant de périmètre.
- Couper sans prévenir un agent en plein travail.
- Spawner des agents sans passer par la revue humaine existante (règle de sécurité de la v1).

## Approches considérées

- **A. Équipes sauvegardées par périmètre dans le même étage — retenue (choix de l'utilisateur).** L'étage
  reste lié au repo. Changer de périmètre enregistre l'équipe courante et archive ses agents ; reprendre
  = les respawner en `--resume`. Réutilise l'archivage et la restauration existants, conserve les
  conversations et worktrees.
- B. Un étage par périmètre (roster propre). Isolation nette mais casse « étage = repo » (identité,
  réouverture au lancement, verrou une-fenêtre-par-repo, migration) : beaucoup de travail, peu de gain.
- C. Équipe = fiches `hire` sur disque, reprise = réimport. Simple mais recrée des agents **sans
  historique** : retire l'intérêt de « reprendre ».

## Conception

### 1. Détection des sous-projets (main)

Nouveau module `src/main/subprojects.ts`, appelé via IPC `floor:subprojects` (repo = celui de l'étage de
l'émetteur, jamais un chemin envoyé par le renderer — même règle que `team:*`).

- Un **sous-projet** = un dossier sous la racine, profondeur ≤ 4, qui contient un manifeste parmi :
  `package.json`, `composer.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`,
  `pom.xml`, `build.gradle(.kts)`, `DESCRIPTION` (R). *(Choix de Claude.)*
- **Repli** *(choix de Claude, après relecture sur GlobalExam)* : un dossier **groupe** est un dossier qui
  contient au moins un sous-projet détecté parmi ses enfants directs (ex. `packages/services`). Tout autre
  enfant direct d'un groupe est aussi listé comme sous-projet même sans manifeste (ex. `sdk/python`,
  `sdk/R`, `services/ai-kev`, `dx/ai`, `infrastructure/local`). Un sous-dossier d'un sous-projet n'est jamais
  listé à part (évite `data/kinesis-pipeline/poc`, `sdk/ai/prompts`).
- On ignore : dossiers cachés, `node_modules`, `vendor`, `dist`, `build`, `.venv`, et tout ce que
  `git check-ignore` exclut. On garde **le plus haut** : un dossier sous un sous-projet déjà détecté n'est
  pas listé à part (ex. `packages/ax` oui, `packages/ax/tooling` non).
- Résultat : `{ path: 'packages/services/live.global-exam.com', label: 'live.global-exam.com',
  group: 'packages/services', kinds: ['composer', 'npm'] }[]`, trié par groupe puis nom. Résultat mis en
  cache par repo pour la session, avec un bouton « Rafraîchir ».
- Plafond : 300 sous-projets, budget ~2 s ; au-delà, liste tronquée avec mention.

### 2. Mode monorepo et périmètre de l'étage

- Le roster de l'étage (`<home>/rosters/<repoSlug>.json`) gagne un champ
  `monorepo?: { enabled: boolean; scope: string[] }` (`scope` = chemins relatifs triés ; vide = « tout le
  repo »). Mêmes garanties de durabilité que le reste du roster. **Attention** : `RosterStore.write`
  (`src/main/roster.ts`) reconstruit le fichier avec une liste fixe de champs et le renderer réécrit tout le
  roster à chaque modification : le champ doit être ajouté au schéma du roster et au miroir renderer
  (`rosterMirror`), sinon il est perdu à la première écriture.
- **Étages existants** *(choix de Claude)* : un roster sans champ `monorepo` est traité comme une première
  ouverture (règle de pré-activation ci-dessous). Les agents déjà présents forment l'équipe du périmètre
  « tout le repo » (`scope: []`) : au premier changement de périmètre ils sont mis de côté sous ce périmètre,
  comme n'importe quelle équipe. **Désactiver** le mode équivaut à choisir le périmètre « tout le repo »
  (même parcours §3 : l'équipe courante est mise de côté, la carte propose l'équipe « tout le repo » si elle
  existe).
- **Pré-activation** *(choix de Claude)* : à la première ouverture d'un étage, si la racine n'a **aucun**
  manifeste et qu'on détecte ≥ 2 sous-projets (cas GlobalExam), le mode est proposé activé ; sinon désactivé.
  Toujours modifiable par une case « Monorepo » dans le panneau périmètre.
- **En-tête de l'étage** : à côté du nom du repo, une puce périmètre, par ex.
  `globalexam · live + core ▾` (au-delà de 2 : `live + core + 1`). Clic → panneau périmètre.

### 3. Panneau « Périmètre »

```
┌ Périmètre — globalexam ─────────────────────── [☑ Monorepo] ┐
│ 🔍 filtrer…                                                   │
│ packages/services                                             │
│   ☑ live.global-exam.com      ☑ core.global-exam.com          │
│   ☐ admin.global-exam.com     ☐ exam.global-exam.com  …       │
│ packages/sdk                                                  │
│   ☐ php   ☐ javascript   ☐ ui  …                              │
│                                   [Annuler]  [Appliquer]      │
└───────────────────────────────────────────────────────────────┘
```

Appliquer une sélection **différente** de l'actuelle :

1. Si l'étage a des agents : confirmation listant l'équipe qui va être mise de côté ; les agents **occupés**
   (tour en cours) sont signalés en tête. *(Choix de Claude : on n'attend pas qu'ils finissent ; on prévient.)*
   La confirmation signale aussi les **tâches ouvertes** du tableau assignées à ces agents ; elles restent
   telles quelles (pas de réassignation, le god n'est pas modifié) et reprennent si l'équipe est reprise.
   *(Choix de Claude.)*
2. L'équipe courante est **enregistrée** pour l'ancien périmètre (§4) puis ses agents sont **mis de côté**
   par un **nouveau chemin**, distinct de la fermeture d'onglet : PTY coupée **sans** `removeWorktree`
   (aujourd'hui `pty:kill` → `teardownPty` supprime le worktree d'un agent isolé, `index.ts` ~l.492-509 et
   ~l.3092), file de messages en attente **conservée** dans l'équipe enregistrée (aujourd'hui
   `archiveAgent` la jette, `store.ts` ~l.823). Les agents mis de côté quittent la liste active de l'étage ;
   ils ne vont pas dans `archivedAgents` : l'équipe enregistrée est leur seul emplacement.
3. Le périmètre de l'étage devient la nouvelle sélection.
4. Si une équipe est enregistrée pour cette sélection exacte → carte « Équipe déjà connue » :

```
┌─ Équipe déjà connue pour live + core ───────────┐
│ 4 agents · composée le 12/11 · utilisée le 14/11 │
│ « Dev back Laravel sur core, dev front Inertia   │
│   sur live, testeur, reviewer »                  │
│ • Kevin — back core   • Pam — front live …       │
│ [Reprendre cette équipe]  [Repartir de zéro]     │
└──────────────────────────────────────────────────┘
```

   Sinon → ouvre directement « Composer l'équipe » sur ce périmètre.

La même carte s'affiche à la place de l'état vide de l'étage tant que l'équipe n'est ni reprise ni
remplacée. Le mode monorepo désactivé = comportement actuel (périmètre = tout le repo, pas d'équipes
mémorisées).

### 4. Équipes mémorisées

Fichiers d'équipes (voir « Historique » ci-dessous) sous `<home>/teams/<repoSlug>/<scopeSlug>/`, `scopeSlug` = 8 hex de
`sha1(scope trié joint par '\n')` préfixé d'un libellé lisible. Écriture atomique, comme le roster.

```ts
interface SavedTeam {
  repoRoot: string;
  scope: string[];            // chemins relatifs triés
  summary: string;            // ≤ 300 caractères
  createdAt: string; usedAt: string;
  agents: PersistedAgent[];   // même forme que roster.restorable : recette de respawn + sessionId
                              // + worktreePath + workdir + file de messages en attente
}
```

- **Quels agents** : tous les agents actifs de l'étage au moment de la mise de côté (y compris ceux ajoutés
  à la main, et seulement ceux réellement lancés). Le god/orchestrateur n'en fait pas partie.
- **Quand** *(choix de Claude)* : le **résumé** est enregistré dès que « Composer l'équipe » a écrit ses
  fiches (`teamSummary` est connu à ce moment) ; la **liste des agents** est prise au moment où l'équipe est
  mise de côté (changement de périmètre). Lancer 2 agents sur 5 proposés = une équipe de 2 agents, résumé
  inchangé. Il n'y a donc pas d'état « composition en cours » à suivre jusqu'au bout de la file.
- **Résumé** : demandé au Claude caché dans la sortie `agents` (nouveau champ optionnel `teamSummary`,
  ≤ 300 car.). Repli s'il manque ou si l'équipe a été faite à la main : liste locale
  `N agents : <nom> — <description>` tronquée. Aucun appel supplémentaire.
- **Reprendre** : respawn des agents en `--resume` en réutilisant la logique de `useRestoreTeam` (même
  recette, même worktree). **Le `cwd` de reprise doit être exactement celui du premier lancement**
  (`<wtPath>/<workdir>` ou `<repo>/<workdir>`) : `--resume` retrouve la session par son dossier, et
  aujourd'hui `useRestoreTeam` reprend à la racine du worktree (`useRestoreTeam.ts` ~l.107-116) — à corriger
  pour tous les agents ayant un `workdir`. Un agent dont la session est introuvable est respawné neuf et
  signalé (« 1 agent repart sans historique »). Sa file de messages en attente est restituée.
- **Historique par périmètre (décidé par l'utilisateur)** : un périmètre peut avoir **plusieurs** équipes
  enregistrées. Stockage : `<home>/teams/<repoSlug>/<scopeSlug>/<createdAt>-<id>.json`, un fichier par
  équipe. La carte montre la plus récemment utilisée, avec un lien « Équipes précédentes (N) » qui déplie
  les autres (date, nombre d'agents, résumé) et permet d'en reprendre une. Aucune équipe n'est jamais
  supprimée automatiquement ; un ✕ « oublier cette équipe » (avec confirmation) permet le ménage.
- **Repartir de zéro** : ouvre « Composer l'équipe » sur le périmètre, sans agents existants. L'équipe
  affichée reste enregistrée telle quelle et passe dans les « Équipes précédentes » dès qu'une nouvelle
  équipe existe pour ce périmètre (résumé écrit). Si on annule la composition, rien ne change et la carte
  reste proposée. Une équipe sans aucun agent lancé n'est pas conservée dans l'historique au moment de la
  mise de côté.

### 5. « Composer l'équipe » ciblée

- `TeamPromptInput` gagne `scope?: string[]`. Le prompt (`buildTeamPrompt`) dit : analyse **uniquement**
  ces sous-dossiers (chemins listés), tu peux lire la config partagée de la racine si elle les concerne ;
  chaque agent travaille dans un de ces sous-dossiers ou sur plusieurs, et le précise.
- Le Claude caché tourne toujours avec `cwd` = racine (pour qu'il puisse lire ce qui est partagé) ; le
  périmètre passe par le prompt. `existingAgents` = agents actifs de l'étage (vide si « Repartir de zéro »).
- **Dossier de travail par agent** : `hire@1` gagne un champ **optionnel** `workdir` (chemin relatif à la
  racine du repo, ≤ 200 car., sans `..`, sans chemin absolu, doit être un dossier existant au moment du
  spawn). Les manifestes existants restent valides. Le prompt demande `workdir` = le sous-projet de l'agent,
  ou omis pour un agent transverse (il démarre alors à la racine). Une carte de la proposition affiche et
  laisse éditer ce champ (liste déroulante des sous-projets du périmètre + « racine »).
- `AddAgentModal` : avec un périmètre d'un seul sous-projet, le dossier est prérempli avec ce
  sous-projet ; avec plusieurs, il propose les sous-projets du périmètre en raccourcis.

### 6. Spawn dans un sous-dossier

- Mode direct : `cwd` = `<repo>/<workdir>`.
- Mode isolé : le worktree est toujours créé pour **le repo entier** (`addWorktree` depuis la racine, comme
  aujourd'hui, `linkWorktreeDeps` depuis la racine), puis l'agent démarre dans `<wtPath>/<workdir>`.
  Aujourd'hui `spawnAgentCore` fait `opts.cwd = wtPath` : il faut garder le sous-chemin relatif
  (`relative(mainRepoRoot(origCwd), origCwd)`) et le réappliquer. `worktreeOrigins` garde le repo d'origine.
- Bloc « Projet » (`projectBlock`) : ajoute `Sous-projet : <workdir>` quand il y en a un.

## Contraintes

- Toute entrée renderer est non fiable : le repo vient de l'étage de l'émetteur, `scope` et `workdir` sont
  validés côté main contre la liste détectée / l'existence réelle sous la racine (pas de `..`, pas de liens
  qui sortent du repo — `realpath` puis préfixe).
- Pas de nouvelle dépendance. Node 22 pour le dev (voir mémoire `node26-electron-env`).
- Tests `node:test` en `.cjs` dans `test/`, comme `compose-team-flow.test.cjs`.

## Laissé au builder

- Découpage exact des composants React (panneau, carte, puce d'en-tête).
- Forme du cache de détection et seuils précis (profondeur, plafond) s'ils posent problème sur GlobalExam.
- Nom des IPC et des actions du store.
