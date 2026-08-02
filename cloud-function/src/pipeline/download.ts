import { DownloadedFile, PipelineJob } from './types';

export async function downloadFile(job: PipelineJob): Promise<DownloadedFile> {
  const res = await fetch(job.downloadUrl);
  if (!res.ok) {
    throw new Error(
      `Download failed for ${job.storagePath}: ${res.status} ${res.statusText}`,
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return {
    buffer,
    filename: job.filename,
    size: buffer.byteLength,
  };
}
