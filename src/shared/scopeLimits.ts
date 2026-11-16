/** Limits of the monorepo scope, shared by main (validation) and the renderer (UI). */

/** Max sub-project paths in one floor scope. */
export const MAX_SCOPE = 40;

/** Max length of a remembered team's one-line summary. */
export const MAX_TEAM_SUMMARY = 300;

/** A remembered team's id (also the `teamId` of a floor scope). */
export const TEAM_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
