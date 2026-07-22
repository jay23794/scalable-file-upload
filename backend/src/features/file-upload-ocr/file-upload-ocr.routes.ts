import { Router } from 'express';
import { upload, list, getById, remove } from './file-upload-ocr.controller';

const router = Router();

router.post('/upload', upload);
router.get('/uploads', list);
router.get('/uploads/:id', getById);
router.delete('/uploads/:id', remove);

export default router;
