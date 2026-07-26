import { Router } from 'express';
import { presign, complete, list, getById, remove } from './file-upload-ocr.controller';

const router = Router();

router.post('/upload/presign', presign);
router.post('/upload/complete', complete);
router.get('/uploads', list);
router.get('/uploads/:id', getById);
router.delete('/uploads/:id', remove);

export default router;
