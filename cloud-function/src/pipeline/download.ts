import { DownloadedFile, PipelineJob } from './types';

export async function downloadFile(job: PipelineJob): Promise<DownloadedFile> {
  const stub = Buffer.from(`stub content for ${job.filename}`);
  return {
    buffer: stub,
    filename: job.filename,
    size: stub.byteLength,
  };
}
