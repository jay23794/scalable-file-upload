import { embedQueue, EmbedJobData } from '../infra/embedQueue';
import { StagedChunks } from './stageChunks';

export async function enqueueEmbedJob(uploadId: string, staged: StagedChunks): Promise<void> {
  const data: EmbedJobData = {
    uploadId,
    chunksPath: staged.chunksPath,
    chunksSignedUrl: staged.chunksSignedUrl,
  };

  await embedQueue.add('embed', data, {
    jobId: uploadId,
  });
}
