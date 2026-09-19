import { Router } from 'express';
import {
  create,
  getById,
  getConversationById,
  listConversations,
  startConversation,
} from './real-time-query-process.controller';
import { stream } from './real-time-query-process.stream';

const router = Router();

router.post('/conversations', startConversation);
router.get('/conversations', listConversations);
router.get('/conversations/:id', getConversationById);

router.post('/queries', create);
router.get('/queries/:id', getById);
// Read-only SSE view onto an in-flight generation. Path A is what persists the
// answer; this endpoint never writes.
router.get('/queries/:id/stream', stream);

export default router;
