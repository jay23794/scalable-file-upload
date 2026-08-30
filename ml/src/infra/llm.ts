import { env } from '../config/env';

// The LLM adapter. A flat file, not a folder — the same reasoning that collapsed
// vectorstore/ once Supabase became the committed choice. Split it the day a
// second provider actually lands, not in anticipation of one.
//
// Only this file knows about @google/genai. Services depend on LlmProvider, so a
// unit test substitutes a fake generator instead of calling Gemini.

/** Why the model stopped. Mirrors GenerationResult['finishReason'] minus 'cancelled'. */
export type LlmFinishReason = 'stop' | 'length';

export interface LlmStreamInput {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** Aborts the upstream HTTP request. The worker wires its job timeout here. */
  signal?: AbortSignal;
}

/**
 * One streamed fragment. Providers emit text in chunks, not in tokens — a chunk
 * is whatever the transport happened to flush.
 *
 * `finishReason` and `outputTokens` ride on the terminal chunk (which may still
 * carry text). Making them part of the chunk rather than a separate call is what
 * lets GenerationResult report 'length' honestly: without it the worker would
 * have to guess at truncation from the output size, and would guess wrong.
 */
export interface LlmChunk {
  text: string;
  finishReason?: LlmFinishReason;
  /** Provider-reported output token count, when it reports one. */
  outputTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  stream(input: LlmStreamInput): AsyncIterable<LlmChunk>;
}

// Gemini's finish reasons are a wider enum than we model. Anything that is not a
// clean stop and not a token-cap hit is a hard failure, so it is thrown rather
// than folded into a finishReason the client would render as a normal answer.
function mapFinishReason(raw: string | undefined): LlmFinishReason | undefined {
  if (!raw) return undefined;
  if (raw === 'STOP') return 'stop';
  if (raw === 'MAX_TOKENS') return 'length';
  throw new Error(`LLM stopped abnormally: ${raw}`);
}

let clientPromise: Promise<{
  models: {
    generateContentStream: (params: Record<string, unknown>) => Promise<AsyncGenerator<unknown>>;
  };
}> | null = null;

async function getClient() {
  if (!clientPromise) {
    if (!env.llm.apiKey) {
      // Lazy on purpose — see the note on env.llm.apiKey. Throwing here fails the
      // one job that needed a key instead of the whole ml service at boot.
      throw new Error('LLM_API_KEY is not set — generation is unavailable');
    }
    clientPromise = (async () => {
      const { GoogleGenAI } = await import('@google/genai');
      return new GoogleGenAI({ apiKey: env.llm.apiKey }) as never;
    })();
  }
  return clientPromise;
}

interface GeminiChunk {
  text?: string;
  candidates?: { finishReason?: string }[];
  usageMetadata?: { candidatesTokenCount?: number };
}

export const llmProvider: LlmProvider = {
  name: env.llm.provider,

  async *stream({ system, prompt, maxOutputTokens, signal }: LlmStreamInput): AsyncIterable<LlmChunk> {
    const client = await getClient();

    const response = await client.models.generateContentStream({
      model: env.llm.model,
      contents: prompt,
      config: {
        systemInstruction: system,
        maxOutputTokens,
        abortSignal: signal,
      },
    });

    for await (const raw of response) {
      const chunk = raw as GeminiChunk;
      const finishReason = mapFinishReason(chunk.candidates?.[0]?.finishReason);
      const outputTokens = chunk.usageMetadata?.candidatesTokenCount;

      // A chunk can carry metadata with no text (Gemini's last frame often
      // does). Skip only chunks that carry nothing at all.
      if (!chunk.text && finishReason === undefined && outputTokens === undefined) continue;

      yield { text: chunk.text ?? '', finishReason, outputTokens };
    }
  },
};
