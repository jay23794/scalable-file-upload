import { Router } from 'express';

import { createRun } from './find-job.controller';

const router = Router();

router.post('/runs', createRun);

export default router;
