export type StorageErrorKind = 'expired' | 'not-found' | 'forbidden' | 'other';

export interface ClassifiedError {
  kind: StorageErrorKind;
  status: number;
  body: string;
}

export async function classifyStorageError(res: Response): Promise<ClassifiedError> {
  const body = await res.text().catch(() => '');
  const status = res.status;
  const lower = body.toLowerCase();

  if (status === 404) {
    return { kind: 'not-found', status, body };
  }

  if ((status === 400 || status === 401 || status === 403) && /expir|invalidjwt|signaturedoesnotmatch/.test(lower)) {
    return { kind: 'expired', status, body };
  }

  if (status === 403) {
    return { kind: 'forbidden', status, body };
  }

  return { kind: 'other', status, body };
}
