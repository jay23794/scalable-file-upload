import { DetectedType, DownloadedFile } from './types';

export async function detectFileType(file: DownloadedFile): Promise<DetectedType> {
  const ext = file.filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'pdf':
      return { mimeType: 'application/pdf', extension: 'pdf', category: 'pdf' };
    case 'png':
    case 'jpg':
    case 'jpeg':
      return { mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, extension: ext, category: 'image' };
    case 'txt':
    case 'md':
      return { mimeType: 'text/plain', extension: ext, category: 'text' };
    default:
      return { mimeType: 'application/octet-stream', extension: ext, category: 'unknown' };
  }
}
