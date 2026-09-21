import { Request, Response } from 'express';

import { findJobService } from '../../infra/container';
import { CreateRunSchema } from './find-job.schema';
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
