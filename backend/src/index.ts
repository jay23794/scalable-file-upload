import express, { Request, Response } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import fileUploadOcrRoutes from './features/file-upload-ocr/file-upload-ocr.routes';
import { startSweeper } from './features/file-upload-ocr/file-upload-ocr.sweeper';
import { startQueueEvents } from './infra/queueEvents';
import { initIo } from './infra/io';
import { fileUploadOcrService } from './infra/container';
import { connectMongo, disconnectMongo } from './infra/mongo';

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
  socket.on('subscribe', async ({ uploadId }: { uploadId: string }) => {
    if (!uploadId) return;
    socket.join(`upload:${uploadId}`);

    const status = await fileUploadOcrService.getStatus(uploadId);
    if (status === 'ready') {
      socket.emit('ocr:completed', { replayed: true });
    } else if (status === 'failed') {
      socket.emit('ocr:failed', { reason: 'previously failed', replayed: true });
    }
  });
});

async function start() {
  await connectMongo();
  httpServer.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
    startQueueEvents();
    startSweeper(fileUploadOcrService);
  });
}

start().catch((err) => {
  console.error('[backend] failed to start:', err);
  process.exit(1);
});

const shutdown = async (signal: NodeJS.Signals) => {
  console.log(`[backend] ${signal} received, shutting down...`);
  httpServer.close();
  await disconnectMongo();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
