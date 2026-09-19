import { Request, Response } from 'express';
import { realTimeQueryProcessService } from '../../infra/container';
import { CreateQuerySchema, StartConversationSchema } from './real-time-query-process.schema';
import { successResponse } from '../../utils/apiResponse';
import { ConversationNotFoundError } from './types';

export const create = async (req: Request, res: Response) => {
  const parsed = CreateQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const data = await realTimeQueryProcessService.submitQuery(parsed.data);
    return res.status(202).json(successResponse(data, 'Query accepted'));
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const startConversation = async (req: Request, res: Response) => {
  // `?? {}` because a body is optional on this route — a bare POST with no
  // Content-Type leaves req.body undefined, and that is a valid request here.
  const parsed = StartConversationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const record = await realTimeQueryProcessService.startConversation(parsed.data);
    // 201, not 202: unlike a query, the conversation fully exists once this
    // returns. There is no background work behind it.
    return res.status(201).json(successResponse(record, 'Conversation started'));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const listConversations = async (_req: Request, res: Response) => {
  try {
    const records = await realTimeQueryProcessService.listConversations();
    return res.json(successResponse(records));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

// One conversation plus its transcript — every turn in it, oldest first.
export const getConversationById = async (req: Request, res: Response) => {
  try {
    const conversation = await realTimeQueryProcessService.getConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }
    const queries = await realTimeQueryProcessService.listConversationQueries(req.params.id);
    return res.json(successResponse({ conversation, queries }));
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
