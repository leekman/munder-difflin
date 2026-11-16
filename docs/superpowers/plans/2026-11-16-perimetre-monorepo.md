# Périmètre monorepo — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** sur un étage, cocher des sous-projets d'un monorepo (le périmètre), composer une équipe ciblée,
mettre de côté / reprendre une équipe par périmètre avec historique.

**Architecture :** détection des sous-projets et stockage des périmètres/équipes côté **main** (fichiers sous
`<home>/teams/<repoSlug>/`, écritures atomiques, chemins validés contre le repo de l'étage émetteur). Le
renderer orchestre le changement de périmètre (mise de côté → enregistrement → reprise ou composition) avec
une logique pure testée (`scopeFlow.ts`). Les agents gagnent un `workdir` relatif, respecté au spawn, en
worktree et à la reprise.

**Tech Stack :** Electron, TypeScript, React + zustand, tests `node:test` en `.cjs` via `test/load-ts.cjs`.

**Spec :** `docs/superpowers/specs/2026-11-16-perimetre-monorepo-design.md`

## Global Constraints

- Node 22 (nvm) pour `npm`, tests et dev ; jamais Node 26 avec Electron.
- Tests : `node --test test/<fichier>.test.cjs` ; tout passe aussi avec `npm run test:focused` et `npm run typecheck`.
- Aucune nouvelle dépendance.
- Entrée renderer = non fiable : le repo est **toujours** `floors.repoOf(evt.sender.id)` (via `teamRepoOf`),
  jamais un chemin envoyé ; `scope`/`workdir` relatifs, sans `..`, sans absolu, `realpath` contenu dans le repo.
- Plafonds : `workdir` ≤ 200 car. ; `teamSummary` ≤ 300 car. ; ≤ 300 sous-projets, profondeur ≤ 4 ; scope ≤ 40 chemins.
- Manifestes de détection : `package.json`, `composer.json`, `pyproject.toml`, `requirements.txt`, `go.mod`,
  `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `DESCRIPTION`.
- Dossiers ignorés : noms commençant par `.`, `node_modules`, `vendor`, `dist`, `build`, `.venv`, + `git check-ignore`.
- Un manifeste ne spawn jamais seul : l'import passe par la revue `AddAgentModal` existante.
- Mettre de côté ne supprime **jamais** un worktree ni une file de messages.
- Textes UI en français, ton de l'app.

**Écart assumé vs spec §2** : l'état `{ enabled, scope }` n'est **pas** stocké dans le roster (le renderer
réécrit tout le roster et `RosterStore.write` filtre les champs) mais dans `<home>/teams/<repoSlug>/floor.json`,
géré uniquement par main. Même durabilité (tmp + rename), aucune modification du schéma roster.

## Review Focus

1. **Sous-projet disparu** (renommé/supprimé entre deux sessions) dans un scope enregistré ou comme `workdir`
   d'un agent : le panneau le montre barré « introuvable » et l'exclut de l'analyse ; la reprise démarre
   l'agent à la racine du repo/worktree et le signale. → tests Task 4 et Task 7.
2. **Même sélection, ordre différent** (`core, live` vs `live, core`) : même équipe. → test Task 4.
3. **Échec d'enregistrement pendant un changement de périmètre** (disque, permission) : on n'arrête **aucun**
   agent ; le changement est annulé avec un message. → test Task 8 (`planScopeSwitch`).
4. **Chemin malveillant** (`../`, absolu, lien symbolique sortant du repo) en `scope` ou `workdir` : refusé
   côté main. → tests Task 2 et Task 4.
5. **Agent occupé** au moment du changement : listé en tête de la confirmation ; rien n'est coupé sans
   confirmation. → test Task 8.

---

### Task 1 : Détection des sous-projets

**Files :**
- Create : `src/main/subprojects.ts`
- Modify : `src/main/index.ts` (handler IPC près de `team:analyze`, ~l.3680), `src/preload/index.ts` (~l.1256)
- Test : `test/subprojects.test.cjs`

**Interfaces :**
- Produces :
  ```ts
  export interface Subproject { path: string; label: string; group: string; kinds: string[] }
  export interface DetectOptions { maxDepth?: number; max?: number; isIgnored?: (rel: string) => Promise<boolean> }
  export async function detectSubprojects(repoRoot: string, opts?: DetectOptions): Promise<{ items: Subproject[]; truncated: boolean }>
  export function rootHasManifest(repoRoot: string): boolean
  ```
  `path` relatif POSIX (`packages/services/live.global-exam.com`), `label` = basename, `group` = dossier
  parent relatif (`''` à la racine), `kinds` ⊂ `['npm','composer','python','go','rust','ruby','maven','gradle','r']`
  (`[]` pour un dossier ajouté par la règle de repli). Tri par `group` puis `label`.
- IPC `floor:subprojects` → `{ items, truncated, rootHasManifest }` pour le repo de l'étage émetteur ;
  cache `Map<repoRoot, résultat>` vidé si l'argument `{ refresh: true }` est passé.
- Preload : `floorSubprojects(refresh?: boolean): Promise<{ items: Subproject[]; truncated: boolean; rootHasManifest: boolean }>`.

- [ ] **Step 1 : tests** sur une arborescence temporaire (`fs.mkdtempSync`) :
  - `detects manifest dirs and keeps the shallowest` : `packages/services/live/composer.json`,
    `packages/services/core/package.json`, `packages/ax/package.json`, `packages/ax/tooling/package.json`
    → paths `packages/ax`, `packages/services/core`, `packages/services/live` (pas `packages/ax/tooling`).
  - `fallback lists manifest-less siblings inside a group` : + `packages/services/ai-kev/` (vide sauf `README.md`)
    → inclus avec `kinds: []` ; `packages/services/live/poc/` (sans manifeste) → **non** inclus.
  - `ignores hidden, node_modules, vendor and isIgnored` : `node_modules/x/package.json`, `.cache/y/package.json`,
    `isIgnored: rel => rel === 'tmp'` avec `tmp/z/package.json` → aucun.
  - `respects maxDepth and max` : `max: 2` → 2 items, `truncated: true`.
  - `rootHasManifest` : vrai avec `package.json` à la racine, faux sinon.
- [ ] **Step 2 :** `node --test test/subprojects.test.cjs` → FAIL (module absent).
- [ ] **Step 3 :** implémenter `detectSubprojects` : parcours en largeur avec `readdirSync({ withFileTypes: true })`,
  sans suivre les liens symboliques ; un dossier avec manifeste est retenu et **non descendu** ; groupe = parent
  d'au moins un sous-projet retenu ; repli : enfants directs dossiers d'un groupe, non ignorés, non déjà retenus.
  `isIgnored` par défaut = `git check-ignore -q <rel>` via `runGit` (exit 0 = ignoré), appelé seulement pour les
  candidats retenus. Défauts `maxDepth: 4`, `max: 300`.
- [ ] **Step 4 :** tests PASS.
- [ ] **Step 5 :** brancher l'IPC (`teamRepoOf(evt.sender)`, `{ items: [], truncated: false, rootHasManifest: true }`
  si pas de repo) et le preload. `npm run typecheck` OK. Ajouter dans `test/floor-ipc-wiring.test.cjs` l'assertion
  que `floor:subprojects` est exposé par le preload (suivre le style existant du fichier).
- [ ] **Step 6 :** commit `feat(monorepo): détection des sous-projets d'un étage`.

### Task 2 : Champ `workdir` dans `hire@1`

**Files :**
- Modify : `src/shared/hire.ts` (interface ~l.46-75, `HIRE_LIMITS` l.100, validation ~l.283, retour l.345),
  `docs/hires/validator.js` (même règle, parité)
- Test : `test/hire-import.test.cjs`, `test/hire-validator-parity.test.cjs`

**Interfaces :**
- Produces : `HireManifest.workdir?: string` ; `HIRE_LIMITS.workdir = 200` ;
  `export function isSafeRelPath(p: string): boolean` (exporté de `hire.ts`, réutilisé Tasks 3-4).

- [ ] **Step 1 : tests** : `workdir` `packages/services/live.global-exam.com` accepté et conservé ;
  refusés avec une erreur contenant `"workdir"` : `../x`, `a/../../b`, `/abs`, `C:\\x`, `a\\b`, `''`, 201 car., non-chaîne ;
  `./a` normalisé en `a` ; slash final retiré. Parité : ajouter ces cas au jeu de la parité.
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** implémenter `isSafeRelPath` (segments séparés par `/`, aucun `..`, pas de `\`, pas de `:`
  ni `/` initial, pas vide après normalisation) et la validation ; même logique dans `docs/hires/validator.js`.
  Ajouter `workdir` (optionnel, relatif à la racine du repo) au texte de spec poussé par `pushModelAndSpec`
  (`src/shared/teamPrompt.ts` ~l.44).
- [ ] **Step 4 :** PASS (+ `test/team-prompt.test.cjs` inchangé vert).
- [ ] **Step 5 :** commit `feat(hire): champ workdir optionnel`.

### Task 3 : Prompt d'équipe ciblé + `teamSummary`

**Files :**
- Modify : `src/shared/teamPrompt.ts` (`TeamPromptInput` l.25, `TeamResponse` l.37, `buildTeamPrompt` l.98, `parseTeamResponse` l.215),
  `src/main/teamComposer.ts` (`sanitizeTeamInput` l.62, `TEAM_INPUT_CAPS`)
- Test : `test/team-prompt.test.cjs`, `test/team-composer.test.cjs`

**Interfaces :**
- Consumes : `isSafeRelPath` (Task 2).
- Produces :
  - `TeamPromptInput.scope?: string[]`
  - `TeamResponse` variante agents : `+ teamSummary?: string` (≤ 300, trim)
  - `sanitizeTeamInput(raw, repoRoot, defaultModel?, allowedScope?: ReadonlySet<string>)` : garde seulement
    les `scope` qui passent `isSafeRelPath` **et** appartiennent à `allowedScope` (si fourni), dédoublonnés,
    triés, ≤ `TEAM_INPUT_CAPS.scope = 40`.

- [ ] **Step 1 : tests** :
  - `buildTeamPrompt with scope lists each path and restricts analysis` : contient chaque chemin et la phrase
    `Analyse UNIQUEMENT ces sous-projets` ; contient `workdir` ; sans scope, le texte est identique à aujourd'hui
    (snapshot de la sortie actuelle pris avant modification).
  - `prompt asks for teamSummary` en round 1 (forme agents) et round 2.
  - `parseTeamResponse keeps teamSummary capped at 300` ; absent → `undefined`.
  - `sanitizeTeamInput filters scope` : `['packages/b','../x','packages/a','packages/a','zzz']` avec
    `allowedScope = {packages/a, packages/b}` → `['packages/a','packages/b']`.
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** implémenter. Texte du bloc scope (français, avant `pushExistingAgents`) :
  `PÉRIMÈTRE : Analyse UNIQUEMENT ces sous-projets (chemins relatifs à la racine) : … Tu peux lire la configuration partagée de la racine si elle les concerne. Pour chaque agent, renseigne "workdir" = le sous-projet où il travaille, ou omets-le pour un agent transverse au périmètre.`
  Dans le format de sortie agents : `{"teamSummary": "<résumé de l'équipe en une phrase, ≤ 300 caractères>", "agents": [...]}`.
  Dans `index.ts` `team:analyze` et `team:prompt` : passer `allowedScope` = paths de `detectSubprojects` (cache Task 1).
- [ ] **Step 4 :** PASS.
- [ ] **Step 5 :** commit `feat(team): composer l'équipe sur un périmètre`.

### Task 4 : Stockage des périmètres et des équipes (main)

**Files :**
- Create : `src/main/teamStore.ts`
- Modify : `src/main/index.ts` (handlers IPC), `src/preload/index.ts`
- Test : `test/team-store.test.cjs`

**Interfaces :**
- Consumes : `repoSlug` (`src/main/roster.ts`), `isSafeRelPath` (Task 2).
- Produces :
  ```ts
  export interface FloorScope { enabled: boolean; scope: string[] }           // scope trié ; [] = tout le repo
  export interface SavedTeam {
    id: string; repoRoot: string; scope: string[]; summary: string;
    createdAt: string; usedAt: string;
    agents: unknown[];                         // PersistedAgent opaques (renderer)
    queues: Record<string, unknown[]>;         // files de messages par agent id
  }
  export function scopeKey(scope: string[]): string            // `<libellé≤40>-<8 hex sha1(trié.join('\n'))>`, `all-…` pour []
  export function readFloorScope(home: string, repoRoot: string): FloorScope | null
  export function writeFloorScope(home: string, repoRoot: string, s: FloorScope): void
  export function listTeams(home: string, repoRoot: string, scope: string[]): SavedTeam[]   // usedAt décroissant
  export function saveTeam(home: string, repoRoot: string, t: Omit<SavedTeam,'id'|'createdAt'|'usedAt'|'repoRoot'> & { id?: string }): SavedTeam
  export function touchTeam(home: string, repoRoot: string, scope: string[], id: string): void
  export function forgetTeam(home: string, repoRoot: string, scope: string[], id: string): boolean
  ```
  Fichiers : `<home>/teams/<repoSlug>/floor.json` et `<home>/teams/<repoSlug>/<scopeKey>/<createdAt-compact>-<id>.json`.
  `saveTeam` avec un `id` existant met à jour ce fichier (garde `createdAt`) ; sans `id` en crée un.
  Écriture tmp + `renameSync`. `saveTeam` refuse (throw) une équipe sans agent **et** sans résumé.
- IPC (repo = étage émetteur, scope validé par `isSafeRelPath`) : `scope:get`, `scope:set`, `teams:list`,
  `teams:save`, `teams:touch`, `teams:forget`. Preload : `scopeGet()`, `scopeSet(s)`, `teamsList(scope)`,
  `teamsSave(t)`, `teamsTouch(scope,id)`, `teamsForget(scope,id)`. `teams:save` renvoie
  `{ ok: true, team } | { ok: false, error }` (jamais de throw vers le renderer).

- [ ] **Step 1 : tests** :
  - `scopeKey is order-independent` : `['live','core']` et `['core','live']` → même clé ; `[]` → préfixe `all-`.
  - `save, list, touch ordering` : deux équipes, `touchTeam` sur la plus ancienne → elle passe en tête.
  - `save with id updates in place` : même fichier, `createdAt` conservé, `summary` mis à jour.
  - `forgetTeam removes only that file`.
  - `floor scope round-trip` + `readFloorScope` → `null` si absent.
  - `rejects unsafe scope paths` : `saveTeam` / `writeFloorScope` avec `'../x'` → throw.
  - `missing subproject is kept in stored scope` : un scope dont un dossier n'existe plus se relit tel quel
    (le filtrage d'affichage est fait par le renderer, Task 8).
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** implémenter + IPC + preload.
- [ ] **Step 4 :** PASS, `npm run typecheck` OK.
- [ ] **Step 5 :** commit `feat(monorepo): équipes mémorisées par périmètre`.

### Task 5 : Spawn dans un sous-dossier (direct et worktree) + bloc Projet

**Files :**
- Modify : `src/main/index.ts` (`spawnAgentCore`, isolation ~l.2769-2797), `src/main/projectInfo.ts`
- Test : `test/project-info.test.cjs`, `test/worktree-subdir.test.cjs` (create)

**Interfaces :**
- Produces :
  - `export function worktreeCwd(wtPath: string, repoRoot: string, origCwd: string): string` dans
    `src/main/projectInfo.ts` : `join(wtPath, relative(repoRoot, origCwd))`, et `wtPath` si le relatif est
    vide ou sort du repo (commence par `..` ou absolu).
  - `ProjectInfo.subdir?: string` (relatif POSIX, absent à la racine) ; `projectBlock` ajoute
    `` Sous-projet : `<subdir>`. `` en fin de phrase quand présent.

- [ ] **Step 1 : tests** : `worktreeCwd('/h/wt/a1','/r','/r/packages/x')` → `/h/wt/a1/packages/x` ;
  `origCwd === repoRoot` → `/h/wt/a1` ; `origCwd='/elsewhere'` → `/h/wt/a1`.
  `resolveProjectInfo` sur un repo git temporaire avec cwd `<repo>/packages/x` → `subdir: 'packages/x'` ;
  `projectBlock` contient `Sous-projet : \`packages/x\``.
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** implémenter ; dans `spawnAgentCore`, calculer `repoRoot = await mainRepoRoot(origCwd)`,
  appeler `addWorktree(repoRoot, …)` et `linkWorktreeDeps(repoRoot, wtPath)` (au lieu de `origCwd`), puis
  `opts.cwd = worktreeCwd(wtPath, repoRoot, origCwd)` ; `worktreePaths` garde `wtPath`, `worktreeOrigins` garde
  `repoRoot`. `subdir` calculé dans `resolveProjectInfo` = `relative(toplevel, canon(cwd))` si non vide et sans `..`.
- [ ] **Step 4 :** PASS + `test/worktree-deps.test.cjs`, `test/hive-cwd.test.cjs` verts.
- [ ] **Step 5 :** commit `feat(spawn): un agent démarre dans son sous-projet, y compris en worktree`.

### Task 6 : Mettre de côté sans détruire (main + store)

**Files :**
- Modify : `src/main/index.ts` (`teardownPty` ~l.470-515, nouvel IPC `pty:park` près de `pty:kill` l.3092),
  `src/preload/index.ts` (~l.532), `src/renderer/src/store/store.ts`
- Create : `src/renderer/src/store/parking.ts`
- Test : `test/parking.test.cjs`

**Interfaces :**
- Produces :
  - `teardownPty(id: string, opts?: { keepWorktree?: boolean })` : avec `keepWorktree`, supprime les entrées
    `worktreePaths`/`worktreeOrigins` **sans** appeler `removeWorktree` ni `finalizeWorkerWorktree`.
  - IPC `pty:park(id)` = `ptyManager.kill(id)` + `teardownPty(id, { keepWorktree: true })`. Preload `parkPty(id)`.
  - `parking.ts` (pur) : `export function parkEntries(agents: Agent[], queues: Record<string, unknown[]>, ids: string[]): { parked: PersistedAgent[]; queues: Record<string, unknown[]>; remaining: Agent[]; remainingQueues: Record<string, unknown[]> }`
    — `parked` via `slimAgents` (exporter `slimAgents` de `store.ts` si besoin), PTY/état live effacés, `worktreePath` et `workdir` conservés.
  - Store : `parkAgents(ids: string[]): { parked: PersistedAgent[]; queues: Record<string, unknown[]> }` —
    retire des `agents` **sans** ajouter à `archivedAgents`, retire leurs queues, persiste le roster.
  - `Agent.workdir?: string` (relatif au repo de l'étage) dans l'interface `Agent` de `store.ts`.

- [ ] **Step 1 : tests** `parkEntries` : 3 agents dont un god (`isGod`) ; `ids` = les deux workers →
  `parked` contient 2 entrées avec `worktreePath`/`workdir` intacts et sans `ptyId` ; `queues` des deux
  transférées ; `remaining` = le god ; `remainingQueues` sans leurs clés. Un id inconnu est ignoré.
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** implémenter ; `parkAgents` appelle `parkEntries` puis `set` + persistance roster existante.
- [ ] **Step 4 :** PASS ; `npm run typecheck` OK.
- [ ] **Step 5 :** commit `feat(roster): mettre des agents de côté sans perdre worktree ni messages`.

### Task 7 : Reprise d'un agent (extraction de `useRestoreTeam`)

**Files :**
- Create : `src/renderer/src/store/respawn.ts`
- Modify : `src/renderer/src/hooks/useRestoreTeam.ts` (~l.95-160 : corps par agent)
- Test : `test/respawn.test.cjs`

**Interfaces :**
- Produces :
  ```ts
  export function restoreCwd(a: { cwd: string; worktreePath?: string; workdir?: string }, worktreeAlive: boolean, floorRepo: string | null):
    { cwd: string; note?: 'worktree-gone' | 'workdir-gone' }
  export async function respawnAgent(a: PersistedAgent, config: HarnessConfig | null):
    Promise<{ agent: Agent | null; error?: string; fresh?: boolean; note?: string }>
  ```
  `restoreCwd` : worktree vivant → `join(worktreePath, workdir ?? '')` ; worktree mort → `a.cwd` (+ `worktree-gone`).
  `respawnAgent` vérifie l'existence du `cwd` choisi via `window.cth.gitIsRepo`/existence ; s'il manque (sous-projet
  disparu) → racine (`worktreePath` ou `floorRepo`) + `note: 'workdir-gone'`. `fresh: true` quand la reprise a dû
  démarrer sans session (`resumeNotFound`).
  `useRestoreTeam` appelle `respawnAgent` pour chaque agent (comportement inchangé hors `workdir`).

- [ ] **Step 1 : tests** `restoreCwd` : worktree vivant + workdir `packages/x` → `<wt>/packages/x` ;
  sans workdir → `<wt>` ; worktree mort → `a.cwd` avec `worktree-gone` ; pas de worktree → `a.cwd`.
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** extraire le corps par agent de `useRestoreTeam` dans `respawnAgent` (même ordre des appels,
  mêmes options `spawnPty`), remplacer le calcul du `cwd` par `restoreCwd`.
- [ ] **Step 4 :** PASS ; tests existants autour de la restauration verts (`npm run test:focused`).
- [ ] **Step 5 :** commit `refactor(restore): reprise d'un agent réutilisable, respecte workdir`.

### Task 8 : Logique de changement de périmètre (pure) + panneau, puce, carte

**Files :**
- Create : `src/renderer/src/components/scopeFlow.ts`, `src/renderer/src/components/ScopePanel.tsx`,
  `src/renderer/src/components/KnownTeamCard.tsx`
- Modify : `src/renderer/src/App.tsx` (en-tête ~l.327-337 : puce ; état vide de l'étage : carte), `src/renderer/src/store/store.ts`
  (`scopePanelOpen`, `floorScope`)
- Test : `test/scope-flow.test.cjs`

**Interfaces :**
- Consumes : `floorSubprojects` (T1), `scopeGet/scopeSet/teamsList/teamsSave/teamsTouch/teamsForget` (T4),
  `parkAgents` + `parkPty` (T6), `respawnAgent` (T7), `existingAgentsOf` (`composeTeamFlow.ts`).
- Produces (`scopeFlow.ts`, pur) :
  ```ts
  export function sameScope(a: string[], b: string[]): boolean
  export function scopeLabel(scope: string[], items: Subproject[]): string    // [] → 'tout le repo' ; 'live + core' ; 'live + core + 1'
  export function shouldPreEnable(rootHasManifest: boolean, count: number): boolean   // !rootHasManifest && count >= 2
  export function splitMissing(scope: string[], items: Subproject[]): { present: string[]; missing: string[] }
  export interface SwitchPlan { toPark: Agent[]; busy: Agent[]; needsConfirm: boolean }
  export function planScopeSwitch(agents: Agent[]): SwitchPlan          // exclut god/assistants ; busy = status de tour en cours
  export async function switchScope(deps: SwitchDeps, from: FloorScope, to: FloorScope, summaryOfCurrent: string): Promise<{ ok: true; known: SavedTeam[] } | { ok: false; error: string }>
  ```
  `SwitchDeps` = `{ agents(): Agent[]; queues(): Record<string, unknown[]>; parkPty(id): Promise<unknown>; parkAgents(ids): {parked; queues}; teamsSave; scopeSet; teamsList; currentTeamId?: string }`.
  Ordre **obligatoire** dans `switchScope` : (1) construire l'équipe à partir des entrées slim **avant** de
  couper quoi que ce soit, (2) `teamsSave` (si l'équipe a ≥ 1 agent) — en cas d'échec retourner `{ ok:false }`
  sans rien couper, (3) `parkPty` de chaque agent, (4) `parkAgents`, (5) `scopeSet(to)`, (6) `teamsList(to.scope)`.
  Résumé de l'équipe mise de côté : celui de l'équipe courante si elle vient d'un `teamsSave` antérieur
  (`currentTeamId`), sinon `localSummary(agents)` = `N agents : <nom> — <description>` tronqué à 300.
  `export function localSummary(agents: { name: string; description?: string }[]): string`.

  UI :
  - Puce d'en-tête `globalexam · <scopeLabel> ▾` visible si `floorScope.enabled` ; ouvre `ScopePanel`.
  - `ScopePanel` : case « Monorepo », filtre texte, groupes, cases ; sous-projets manquants barrés « introuvable » ;
    « Rafraîchir » ; « Appliquer » désactivé si sélection inchangée. Si `planScopeSwitch.needsConfirm` :
    confirmation listant les agents (occupés en tête, libellé « en cours ») et le nombre de tâches ouvertes
    assignées (via l'API tâches existante du hive côté renderer) ; texte « Ces agents sont mis de côté avec leur
    conversation et leur worktree. Tu pourras reprendre cette équipe. »
  - Décocher « Monorepo » = `switchScope` vers `{ enabled:false, scope: [] }`.
  - `KnownTeamCard` : équipe en tête (`N agents · composée le … · utilisée le …`, résumé, noms/descriptions),
    boutons « Reprendre cette équipe » / « Repartir de zéro », lien « Équipes précédentes (N) » qui déplie les
    autres (chacune avec « Reprendre » et ✕ « Oublier » confirmé). Affichée dans l'état vide de l'étage quand
    `teamsList(scope)` est non vide.
  - Reprendre : `respawnAgent` pour chaque agent (concurrence comme `useRestoreTeam`, ajout dans l'ordre),
    restituer les queues, `teamsTouch`, retenir `currentTeamId` ; afficher les notes
    (« N agent(s) repart(ent) sans historique », « sous-projet introuvable : démarré à la racine »).
  - Repartir de zéro : ouvre `ComposeTeamModal` en mode scratch (Task 9).
  - Premier chargement : si `scopeGet()` → `null`, `writeFloorScope` avec `shouldPreEnable(...)` et `scope: []`.

- [ ] **Step 1 : tests** (`scope-flow.test.cjs`) :
  - `sameScope` insensible à l'ordre ; `scopeLabel` : `[]`, 1, 2, 3 éléments (labels = `label` des items).
  - `shouldPreEnable(false, 2) === true`, `(true, 10) === false`, `(false, 1) === false`.
  - `splitMissing` sépare les chemins absents de `items`.
  - `planScopeSwitch` exclut `isGod`/`isAssistant`, place les agents occupés dans `busy`, `needsConfirm` faux si aucun agent.
  - `switchScope aborts without parking when save fails` : `teamsSave` rejette → `ok:false`, `parkPty` jamais appelé.
  - `switchScope saves before parking` : ordre des appels enregistré = `teamsSave, parkPty×N, parkAgents, scopeSet, teamsList`.
  - `switchScope with no agents skips save` ; avec `currentTeamId` et 0 agent → `teamsForget(currentTeamId)`.
  - `localSummary` tronque à 300.
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** implémenter `scopeFlow.ts`, puis les composants et le branchement `App.tsx`.
- [ ] **Step 4 :** PASS ; `npm run typecheck` OK.
- [ ] **Step 5 :** commit `feat(monorepo): changer de périmètre, reprendre une équipe`.

### Task 9 : Composer l'équipe et Ajouter un agent avec périmètre

**Files :**
- Modify : `src/renderer/src/components/ComposeTeamModal.tsx` (`promptInput` l.62, écriture ~l.150, `importNow` l.163),
  `src/renderer/src/components/composeTeamFlow.ts`, `src/renderer/src/components/AddAgentModal.tsx` (cwd l.199, hire l.158-254)
- Test : `test/compose-team-flow.test.cjs`

**Interfaces :**
- Consumes : `floorScope` (store, T8), `teamsSave` (T4), `Subproject` (T1), `HireManifest.workdir` (T2), `localSummary` (T8).
- Produces :
  - `ComposeTeamModal` prop `mode?: 'normal' | 'scratch'` : en `scratch`, `existingAgents: []`.
  - `promptInput` ajoute `scope: floorScope.scope` (sans les chemins manquants) quand `floorScope.enabled`.
  - Après `teamWrite` réussi : `teamsSave({ scope, summary: res.teamSummary ?? localSummary(manifests), agents: [], queues: {} })`
    et retenir l'id renvoyé comme `currentTeamId` (store) ; les agents réels y sont ajoutés à la mise de côté (T8).
  - Carte de proposition : sélecteur `workdir` = sous-projets du périmètre + « racine » ; valeur initiale = `manifest.workdir`
    si elle est dans le périmètre, sinon « racine ».
  - `composeTeamFlow.ts` : `export function workdirOptions(scope: string[], items: Subproject[]): { value: string; label: string }[]`
    (`''` = racine en premier).
  - `AddAgentModal` : `cwd` initial = `join(floorRepo, pendingHire.workdir)` si présent et existant ; sinon,
    périmètre d'un seul sous-projet → `join(floorRepo, scope[0])` ; sinon `floorRepo`. Avec ≥ 2 sous-projets,
    raccourcis cliquables vers chacun. Au spawn, `Agent.workdir = relative(floorRepo, cwdChoisi)` si non vide et sans `..`.

- [ ] **Step 1 : tests** : `workdirOptions(['packages/a','packages/b'], items)` → racine + 2 options avec labels ;
  `cardsFromResponse` conserve `workdir` ; `prepareWrite` le transmet ; un `workdir` hors périmètre est remplacé par `''`
  (racine) avant écriture.
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** PASS ; `npm run typecheck` OK.
- [ ] **Step 5 :** commit `feat(team): composer et ajouter des agents dans le périmètre`.

### Task 10 : Vérification d'ensemble

- [ ] **Step 1 :** `npm run test:focused` et `npm run typecheck` → tout vert (coller la sortie résumée).
- [ ] **Step 2 :** lancer l'app (`npm run dev`, Node 22) sur l'étage `~/code/globalexam` et dérouler :
  pré-activation du mode ; cocher `live` + `core` ; confirmation listant les agents actuels ; composer → cartes avec
  `workdir` ; lancer 2 agents (un isolé) ; vérifier le `cwd` dans `<worktree>/packages/services/...` ; passer à
  `sdk/php` → worktree toujours présent sur disque ; revenir à live+core → carte avec résumé → « Reprendre » →
  conversations retrouvées ; « Repartir de zéro » → l'ancienne équipe apparaît dans « Équipes précédentes (1) ».
  Noter tout écart dans le ledger.
- [ ] **Step 3 :** commit des éventuels correctifs, puis superpowers:finishing-a-development-branch.
