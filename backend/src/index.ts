import express, { Request, Response } from 'express';
import cors from 'cors';
import fileUploadOcrRoutes from './features/file-upload-ocr/file-upload-ocr.routes';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.use('/api/file-upload-ocr', fileUploadOcrRoutes);

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
