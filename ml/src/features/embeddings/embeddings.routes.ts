import { Router } from 'express';
import { requireReady } from '../../infra/readiness';
import { embed } from './embeddings.controller';

export const embeddingsRouter = Router();

embeddingsRouter.post('/embed', requireReady, embed);
