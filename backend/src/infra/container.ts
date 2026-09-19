import { ConversationRepository } from '../features/real-time-query-process/repository/conversation.repository';
import { FileUploadOcrRepository } from '../features/file-upload-ocr/file-upload-ocr.repository';
import { FileUploadOcrService } from '../features/file-upload-ocr/file-upload-ocr.service';
import { InternalService } from '../features/internal/internal.service';
import { RealTimeQueryProcessRepository } from '../features/real-time-query-process/repository/real-time-query-process.repository';
import { RealTimeQueryProcessService } from '../features/real-time-query-process/real-time-query-process.service';
import { SupabaseStorageService } from './storage';
import { ocrQueue } from './queue';
import { embedQueue } from './embedQueue';
import { generateQueue } from './generateQueue';

const _fileUploadOcrRepository = new FileUploadOcrRepository();
const _realTimeQueryProcessRepository = new RealTimeQueryProcessRepository();
const _conversationRepository = new ConversationRepository();
const _storage = new SupabaseStorageService();

export const fileUploadOcrService = new FileUploadOcrService(
  _fileUploadOcrRepository,
  _storage,
  ocrQueue,
  embedQueue,
);

export const realTimeQueryProcessService = new RealTimeQueryProcessService(
  _realTimeQueryProcessRepository,
  _conversationRepository,
  generateQueue,
);

export const internalService = new InternalService(_storage);
