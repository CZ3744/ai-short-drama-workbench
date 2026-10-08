/**
 * v2 Ledger Controller — Query cost ledger
 */

import { Router } from "express";
import { queryLedger, aggregateLedger } from "./seriesStore";

export const ledgerRouter = Router();

// GET /ledger
ledgerRouter.get("/ledger", async (req, res, next) => {
  try {
    const filter = {
      series_slug: req.query.series_slug as string | undefined,
      since: req.query.since as string | undefined,
      until: req.query.until as string | undefined,
    };
    const entries = await queryLedger(filter);
    res.json({ entries });
  } catch (err) { next(err); }
});

// GET /ledger/aggregate
ledgerRouter.get("/ledger/aggregate", async (req, res, next) => {
  try {
    const filter = {
      series_slug: req.query.series_slug as string | undefined,
    };
    const result = await aggregateLedger(filter);
    res.json(result);
  } catch (err) { next(err); }
});
