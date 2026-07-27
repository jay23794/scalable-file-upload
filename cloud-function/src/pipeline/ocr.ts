import { createWorker } from 'tesseract.js';
import { PDFParse } from 'pdf-parse';
import { DetectedType, DownloadedFile, ExtractedText } from './types';

export async function extractText(
  file: DownloadedFile,
  type: DetectedType,
): Promise<ExtractedText> {
  if (type.category === 'text') {
    return { text: file.buffer.toString('utf8') };
  }

  if (type.category === 'pdf') {
    const parser = new PDFParse({ data: file.buffer });
    try {
      const result = await parser.getText();
      return { text: result.text, pages: result.total };
    } finally {
      await parser.destroy();
    }
  }

  if (type.category === 'image') {
    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(file.buffer);
      return { text: data.text, confidence: data.confidence };
    } finally {
      await worker.terminate();
    }
  }

  throw new Error(`Unsupported file category: ${type.category}`);
}
