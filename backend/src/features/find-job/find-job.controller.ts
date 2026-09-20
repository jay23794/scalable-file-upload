import { Request, Response } from 'express';

import { findJobService } from '../../infra/container';
import { CreateRunSchema, ListJobsQuerySchema } from './find-job.schema';
import { successResponse } from '../../utils/apiResponse';

export const createRun = async (req: Request, res: Response) => {
  const parsed = CreateRunSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const result = await findJobService.createRun(parsed.data);
    // 202, not 201: nothing the client asked for exists yet. siteCount tells
    // the caller how many things to wait on.
    return res.status(202).json(successResponse(result, 'Scrape run accepted'));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const getRun = async (req: Request, res: Response) => {
  try {
    const run = await findJobService.getRun(req.params.runId);
    if (!run) {
      return res.status(404).json({ success: false, error: 'Scrape run not found' });
    }
    // Status only, never the postings: this is polled, and a run produces
    // hundreds of large documents.
    return res.json(successResponse(run));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const listJobs = async (req: Request, res: Response) => {
  const parsed = ListJobsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const run = await findJobService.getRun(req.params.runId);
    if (!run) {
      return res.status(404).json({ success: false, error: 'Scrape run not found' });
    }
    const result = await findJobService.listJobs(req.params.runId, parsed.data);
    return res.json(successResponse(result));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const removeRun = async (req: Request, res: Response) => {
  try {
    const ok = await findJobService.deleteRun(req.params.runId);
    if (!ok) {
      return res.status(404).json({ success: false, error: 'Scrape run not found' });
    }
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};
