import { Router } from 'express';
import { requireInternalAuth } from './internal.middleware';
import { signedUrl } from './internal.controller';

const router = Router();

router.use(requireInternalAuth);
router.post('/signed-url', signedUrl);

export default router;
