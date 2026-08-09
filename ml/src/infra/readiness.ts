import { NextFunction, Request, Response } from 'express';

export const readiness = {
  modelReady: false,
  milvusReady: false,
};

export function isReady(): boolean {
  return readiness.modelReady && readiness.milvusReady;
}

export function requireReady(_req: Request, res: Response, next: NextFunction): void {
  if (isReady()) {
    next();
    return;
  }
  res.status(503).json({
    error: 'ml service warming up',
    modelReady: readiness.modelReady,
    milvusReady: readiness.milvusReady,
  });
}
