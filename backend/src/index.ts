import express, { Request, Response } from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.post('/api/query', (req: Request, res: Response) => {
  const { message } = req.body ?? {};
  res.json({ reply: `Received: ${message ?? ''}` });
});

app.post('/api/upload', (req: Request, res: Response) => {
  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
