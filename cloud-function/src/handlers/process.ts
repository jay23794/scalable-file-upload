import { downloadFile } from '../pipeline/download';
import { detectFileType } from '../pipeline/detectType';
import { extractText } from '../pipeline/ocr';
import { cleanText } from '../pipeline/cleanText';
import { chunkText } from '../pipeline/chunkText';
import { stageChunks } from '../pipeline/stageChunks';
import { enqueueEmbedJob } from '../pipeline/enqueueEmbed';
import { storeMetadata, StoredMetadata } from '../pipeline/storeMetadata';
import { OnProgress, PipelineContext, PipelineJob } from '../pipeline/types';

export async function runPipeline(
  job: PipelineJob,
  onProgress?: OnProgress,
): Promise<StoredMetadata> {
  const ctx: PipelineContext = { job };

  await onProgress?.({ step: 'download', pct: 10 });
  ctx.file = await downloadFile(job);

  await onProgress?.({ step: 'detect', pct: 25 });
  ctx.type = await detectFileType(ctx.file);

  await onProgress?.({ step: 'ocr', pct: 40 });
  ctx.extracted = await extractText(ctx.file, ctx.type);

  await onProgress?.({ step: 'clean', pct: 60 });
  ctx.cleaned = cleanText(ctx.extracted.text);

  await onProgress?.({ step: 'chunk', pct: 70 });
  ctx.chunks = chunkText(ctx.cleaned);

  await onProgress?.({ step: 'stage', pct: 82 });
  const staged = await stageChunks(job.uploadId, ctx.chunks);
  ctx.staged = { chunksPath: staged.chunksPath };

  await onProgress?.({ step: 'enqueue', pct: 90 });
  await enqueueEmbedJob(job.uploadId, staged);

  await onProgress?.({ step: 'store', pct: 95 });
  return storeMetadata(ctx);
}
