import { ConversationRepository } from '../features/real-time-query-process/repository/conversation.repository';
import { FileUploadOcrRepository } from '../features/file-upload-ocr/file-upload-ocr.repository';
import { FindJobRepository } from '../features/find-job/repository/find-job.repository';
import { FindJobService } from '../features/find-job/find-job.service';
import { RawJobRepository } from '../features/find-job/repository/raw-job.repository';
import { FileUploadOcrService } from '../features/file-upload-ocr/file-upload-ocr.service';
import { InternalService } from '../features/internal/internal.service';
import { RealTimeQueryProcessRepository } from '../features/real-time-query-process/repository/real-time-query-process.repository';
import { RealTimeQueryProcessService } from '../features/real-time-query-process/real-time-query-process.service';
import { SupabaseStorageService } from './storage';
import { ocrQueue } from './queue';
import { embedQueue } from './embedQueue';
import { generateQueue } from './generateQueue';
import { scrapeQueue } from './scrapeQueue';

const _fileUploadOcrRepository = new FileUploadOcrRepository();
const _realTimeQueryProcessRepository = new RealTimeQueryProcessRepository();
const _conversationRepository = new ConversationRepository();
const _findJobRepository = new FindJobRepository();
const _rawJobRepository = new RawJobRepository();
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

export const findJobService = new FindJobService(
  _findJobRepository,
  _rawJobRepository,
  scrapeQueue,
);

export const internalService = new InternalService(_storage);
