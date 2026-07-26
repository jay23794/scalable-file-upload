export interface UploadRecord {
  id: string;
  path: string;
  filename: string;
  size: number;
  mimeType: string;
  createdAt: Date;
}

export class FileUploadOcrRepository {
  private store = new Map<string, UploadRecord>();

  create(record: UploadRecord): UploadRecord {
    this.store.set(record.id, record);
    return record;
  }

  findById(id: string): UploadRecord | undefined {
    return this.store.get(id);
  }

  list(): UploadRecord[] {
    return Array.from(this.store.values());
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }
}
