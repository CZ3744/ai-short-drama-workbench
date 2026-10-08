/**
 * Provider Controller — Shim re-export (Wave Z-9).
 *
 * The implementation has been split into sub-modules under providerController/:
 *   - shared.ts  — types, storage helpers, builtin presets, status computation
 *   - crud.ts    — P5E CRUD endpoints
 *   - health.ts  — health, chain, test, speed-test endpoints
 *   - index.ts   — mounts sub-routers and re-exports public API
 */

export { providerRouter } from "./providerController/index";
export { resolveProvider, readCustomProviders, getBuiltinPresets } from "./providerController/index";
export { computeProviderStatus, statusDotColor } from "./providerController/index";
export type { ProviderFourState } from "./providerController/index";
