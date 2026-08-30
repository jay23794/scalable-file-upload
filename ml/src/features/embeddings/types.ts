// Queue contract for embed-queue. The producer side is declared in
// backend/src/infra/embedQueue.ts — if this shape changes, update both.
export interface EmbedJobData {
  uploadId: string;
  chunksPath: string;
  chunksSignedUrl: string;
}

// Job return value. Travels back over BullMQ and is read by the backend's
// QueueEvents 'completed' handler, which parses it into a PipelineSummary.
export interface EmbedJobResult {
  uploadId: string;
  chunkCount: number;
  dim: number;
  model: string;
  storedAt: string;
}
