/**
 * Provider Controller — Index
 *
 * Wave Z-9: Split 1119-line providerController.ts into sub-modules.
 * This index mounts all sub-routers and re-exports the public API.
 */

import { Router } from "express";
import { crudRouter } from "./crud";
import { healthRouter } from "./health";

export const providerRouter = Router();

providerRouter.use(crudRouter);
providerRouter.use(healthRouter);

// Re-export public API for external consumers
export { resolveProvider, readCustomProviders, getBuiltinPresets } from "./shared";
export { computeProviderStatus, statusDotColor } from "./shared";
export type { ProviderFourState } from "./shared";
