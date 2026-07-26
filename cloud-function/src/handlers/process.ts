import { downloadFile } from '../pipeline/download';
import { detectFileType } from '../pipeline/detectType';
import { extractText } from '../pipeline/ocr';
import { cleanText } from '../pipeline/cleanText';
import { chunkText } from '../pipeline/chunkText';
import { callMlService } from '../pipeline/callMlService';
import { storeMetadata, StoredMetadata } from '../pipeline/storeMetadata';
import { notifyStatus } from '../pipeline/notifyStatus';
import { PipelineContext, PipelineJob } from '../pipeline/types';

export async function runPipeline(job: PipelineJob): Promise<StoredMetadata> {
  const ctx: PipelineContext = { job };

  await notifyStatus({ jobId: job.jobId, uploadId: job.uploadId, status: 'processing' });

  try {
    ctx.file = await downloadFile(job);
    ctx.type = await detectFileType(ctx.file);
    ctx.extracted = await extractText(ctx.file, ctx.type);
    ctx.cleaned = cleanText(ctx.extracted.text);
    ctx.chunks = chunkText(ctx.cleaned);
    ctx.ml = await callMlService(ctx.chunks);

    const meta = await storeMetadata(ctx);

    await notifyStatus({
      jobId: job.jobId,
      uploadId: job.uploadId,
      status: 'completed',
      data: meta,
    });

    return meta;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    await notifyStatus({
      jobId: job.jobId,
      uploadId: job.uploadId,
      status: 'failed',
      message,
    });
    throw err;
  }
}
