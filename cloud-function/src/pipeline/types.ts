export interface OcrJobData {
  uploadId: string;
  storagePath: string;
  filename: string;
  mimeType: string;
}

export interface PipelineJob {
  jobId: string;
  uploadId: string;
  storagePath: string;
  filename: string;
  mimeType?: string;
}

export interface DownloadedFile {
  buffer: Buffer;
  filename: string;
  size: number;
}

export interface DetectedType {
  mimeType: string;
  extension: string;
  category: 'image' | 'pdf' | 'text' | 'unknown';
}

export interface ExtractedText {
  text: string;
  pages?: number;
}

export interface TextChunk {
  index: number;
  content: string;
  tokens: number;
}

export interface MlServiceResult {
  embeddings: number[][];
  model: string;
}

export interface PipelineContext {
  job: PipelineJob;
  file?: DownloadedFile;
  type?: DetectedType;
  extracted?: ExtractedText;
  cleaned?: string;
  chunks?: TextChunk[];
  ml?: MlServiceResult;
}
