import { Request, Response } from 'express';
import { realTimeQueryProcessService } from '../../infra/container';
import { CreateQuerySchema } from './real-time-query-process.schema';
import { successResponse } from '../../utils/apiResponse';

export const create = async (req: Request, res: Response) => {
  const parsed = CreateQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const data = await realTimeQueryProcessService.submitQuery(parsed.data);
    // 202, not 201: the answer does not exist yet. Generation runs in the
    // background and the client watches it over SSE.
    return res.status(202).json(successResponse(data, 'Query accepted'));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const list = async (_req: Request, res: Response) => {
  try {
    const records = await realTimeQueryProcessService.listQueries();
    return res.json(successResponse(records));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const getById = async (req: Request, res: Response) => {
  try {
    const record = await realTimeQueryProcessService.getQuery(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, error: 'Query not found' });
    }
    return res.json(successResponse(record));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};
