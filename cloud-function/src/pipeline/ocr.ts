import { DetectedType, DownloadedFile, ExtractedText } from './types';

export async function extractText(
  file: DownloadedFile,
  type: DetectedType,
): Promise<ExtractedText> {
  if (type.category === 'text') {
    return { text: file.buffer.toString('utf8') };
  }

  return {
    text: `[stub OCR output for ${file.filename}] Lorem ipsum dolor sit amet.`,
    pages: type.category === 'pdf' ? 1 : undefined,
  };
}
