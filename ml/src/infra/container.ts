import { EmbeddingsRepository } from '../features/embeddings/embeddings.repository';
import { EmbeddingsService } from '../features/embeddings/embeddings.service';
import { GenerationRepository } from '../features/generation/generation.repository';
import { GenerationService } from '../features/generation/generation.service';
import { embedder } from './embedder';
import { llmProvider } from './llm';
import { vectorStore } from './vectorstore';

// Composition root — mirrors backend/src/infra/container.ts. Every dependency
// is resolved once, here, and injected. Nothing below constructs its own
// collaborators, which is what makes the services testable without a live
// Supabase project, a loaded ONNX model, or a Gemini key.
//
// The store object is inert until init() opens the connection during bootstrap,
// and llmProvider does not construct its client until the first job runs.
const _embeddingsRepository = new EmbeddingsRepository(vectorStore);
const _generationRepository = new GenerationRepository(vectorStore);

export const embeddingsService = new EmbeddingsService(embedder, _embeddingsRepository);

// Ingestion and query embeddings share one Embedder by construction — the same
// singleton is injected into both services. Mixing models here would make the
// stored vectors and the query vector incomparable, and retrieval would return
// noise rather than fail loudly.
export const generationService = new GenerationService(
  embedder,
  _generationRepository,
  llmProvider,
);
