import { Router } from 'express';
import { create, getById, list } from './real-time-query-process.controller';

const router = Router();

router.post('/queries', create);
router.get('/queries', list);
router.get('/queries/:id', getById);
// GET /queries/:id/stream is added in the SSE stage.

export default router;
