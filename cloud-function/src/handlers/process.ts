import { downloadFile } from '../pipeline/download';
import { detectFileType } from '../pipeline/detectType';
import { extractText } from '../pipeline/ocr';
import { cleanText } from '../pipeline/cleanText';
import { chunkText } from '../pipeline/chunkText';
import { callMlService } from '../pipeline/callMlService';
import { storeMetadata, StoredMetadata } from '../pipeline/storeMetadata';
import { PipelineContext, PipelineJob } from '../pipeline/types';

export async function runPipeline(job: PipelineJob): Promise<StoredMetadata> {
  const ctx: PipelineContext = { job };

  ctx.file = await downloadFile(job);
  ctx.type = await detectFileType(ctx.file);
  ctx.extracted = await extractText(ctx.file, ctx.type);
  ctx.cleaned = cleanText(ctx.extracted.text);
  ctx.chunks = chunkText(ctx.cleaned);
  ctx.ml = await callMlService(ctx.chunks);

  return storeMetadata(ctx);
}
