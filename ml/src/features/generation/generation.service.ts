import { env } from '../../config/env';
import { Embedder } from '../../infra/embedder';
import { LlmFinishReason, LlmProvider } from '../../infra/llm';
import { SearchHit } from '../../infra/vectorstore';
import { GenerationRepository } from './generation.repository';
import { GenerateJobData, GenerationResult, SourceRef, StreamEvent } from './types';

// Total characters of retrieved text handed to the model. A cap is needed
// because topK bounds the *number* of chunks, not their size — a handful of
// oversized chunks would otherwise blow past the context window and cost real
// money. Chunks are rank-ordered, so trimming from the tail drops the least
// relevant material first.
const CONTEXT_CHAR_BUDGET = 12_000;

const SYSTEM_PROMPT = [
  'You are a retrieval-grounded assistant answering questions about the user\'s documents.',
  'Use ONLY the numbered context blocks provided. Do not use outside knowledge.',
  'Cite the blocks you rely on inline as [source N].',
  'If the context does not contain the answer, say so plainly instead of guessing.',
].join(' ');

interface BuiltContext {
  block: string;
  sources: SourceRef[];
}

/**
 * Renders hits as `[source N]` blocks and returns the SourceRef list for exactly
 * the blocks that made it in — a citation the model cannot see would be a lie in
 * the done event.
 */
export function buildContext(hits: SearchHit[]): BuiltContext {
  const parts: string[] = [];
  const sources: SourceRef[] = [];
  let used = 0;

  for (const hit of hits) {
    const body = `[source ${sources.length + 1}] (${hit.upload_id}#${hit.chunk_index})\n${hit.text}`;
    // Stop rather than skip-and-continue: hits are ordered by score, so once one
    // does not fit, the rest are both larger-than-budget and less relevant.
    if (used + body.length > CONTEXT_CHAR_BUDGET) break;

    parts.push(body);
    sources.push({
      uploadId: hit.upload_id,
      chunkIndex: hit.chunk_index,
      score: hit.score,
    });
    used += body.length;
  }

  return { block: parts.join('\n\n'), sources };
}

function buildPrompt(question: string, context: string): string {
  if (context === '') {
    return (
      `No context could be retrieved for this question.\n\n` +
      `Question: ${question}\n\n` +
      `Tell the user you found nothing relevant in the selected documents.`
    );
  }
  return `Context:\n\n${context}\n\n---\n\nQuestion: ${question}`;
}

export class GenerationService {
  constructor(
    private _embedder: Embedder,
    private _repo: GenerationRepository,
    private _llm: LlmProvider,
  ) {}

  /**
   * Runs one generation end to end.
   *
   * `onEvent` is injected rather than imported so the service never touches
   * Redis — that is what makes it unit-testable with stubs, and it keeps the
   * transport decision (Redis Stream today) out of the pipeline logic.
   */
  async run(
    job: GenerateJobData,
    onEvent: (e: StreamEvent) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<GenerationResult> {
    await onEvent({ type: 'progress', step: 'embed', pct: 15 });
    const [embedding] = await this._embedder.encode([job.query]);
    if (!embedding) {
      throw new Error('embedder returned no vector for the query');
    }

    await onEvent({ type: 'progress', step: 'search', pct: 35 });
    const hits = await this._repo.search({
      embedding,
      uploadIds: job.connectors,
      topK: job.topK ?? env.query.topKDefault,
    });

    await onEvent({ type: 'progress', step: 'context', pct: 50 });
    const { block, sources } = buildContext(hits);

    await onEvent({ type: 'progress', step: 'llm', pct: 65 });

    let text = '';
    let index = 0;
    let finishReason: LlmFinishReason | undefined;
    let outputTokens: number | undefined;

    for await (const chunk of this._llm.stream({
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(job.query, block),
      maxOutputTokens: env.llm.maxOutputTokens,
      signal,
    })) {
      if (chunk.finishReason !== undefined) finishReason = chunk.finishReason;
      if (chunk.outputTokens !== undefined) outputTokens = chunk.outputTokens;

      if (chunk.text === '') continue;
      text += chunk.text;
      await onEvent({ type: 'token', text: chunk.text, index: index++ });
    }

    return {
      text,
      sources,
      // The provider's own count when it gives one; otherwise the number of
      // fragments emitted, which is what the client counted too.
      totalTokens: outputTokens ?? index,
      // A provider that streamed to the end without saying why is a clean stop.
      finishReason: finishReason ?? 'stop',
    };
  }
}
