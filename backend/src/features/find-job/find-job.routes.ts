import { Router } from 'express';

import { createRun, getRun, listJobs, removeRun } from './find-job.controller';

const router = Router();

router.post('/runs', createRun);
router.get('/runs/:runId', getRun);
router.get('/runs/:runId/jobs', listJobs);
router.delete('/runs/:runId', removeRun);

export default router;
