/**
 * Product surfaces that are built but switched off. One line each, read by the web app, the
 * landing page and the docs site, so turning a surface back on is one edit here.
 *
 * Zod-free (like `./vocabulary`): the web app imports it from its entry chunk.
 */

/**
 * GitHub integration in the product surface: the GitHub settings page and its nav and palette
 * entries, "Continue with GitHub", the first-run "Connect GitHub" step, the landing's
 * "Bring your repositories" section and the docs' GitHub paths and guides. Off (2026-10-11, the
 * owner's call): the code, the GitHub App backend and GitHub PR text stay; they are just not shown.
 * Docs pages stay built at their URLs and in llms.txt for agents; they leave the human navigation.
 */
export const GITHUB_SURFACES: boolean = false;
