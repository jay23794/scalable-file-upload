import express, { Request, Response } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import fileUploadOcrRoutes from './features/file-upload-ocr/file-upload-ocr.routes';
import { startQueueEvents } from './infra/queueEvents';
import { initIo } from './infra/io';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.use('/api/v1/file-upload-ocr', fileUploadOcrRoutes);

const httpServer = createServer(app);
const io = initIo(httpServer);

io.on('connection', (socket) => {
  socket.on('subscribe', ({ uploadId }: { uploadId: string }) => {
    if (!uploadId) return;
    socket.join(`upload:${uploadId}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
  startQueueEvents();
});
