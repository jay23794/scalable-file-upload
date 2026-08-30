import { EmbeddingsRepository } from '../features/embeddings/embeddings.repository';
import { EmbeddingsService } from '../features/embeddings/embeddings.service';
import { embedder } from './embedder';
import { vectorStore } from './vectorstore';

// Composition root — mirrors backend/src/infra/container.ts. Every dependency
// is resolved once, here, and injected. Nothing below constructs its own
// collaborators, which is what makes the services testable without a live
// Supabase project or a loaded ONNX model.
//
// The store object is inert until init() opens the connection during bootstrap.
const _embeddingsRepository = new EmbeddingsRepository(vectorStore);

export const embeddingsService = new EmbeddingsService(embedder, _embeddingsRepository);
