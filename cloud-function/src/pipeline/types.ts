export interface OcrJobData {
  uploadId: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  downloadUrl: string;
}

export interface PipelineJob {
  jobId: string;
  uploadId: string;
  storagePath: string;
  filename: string;
  mimeType?: string;
  downloadUrl: string;
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
  confidence?: number;
}

export interface PipelineProgress {
  step: 'download' | 'detect' | 'ocr' | 'clean' | 'chunk' | 'ml' | 'store';
  pct: number;
}

export type OnProgress = (progress: PipelineProgress) => void | Promise<void>;

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
