import { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';

export function requireInternalAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const expected = `Bearer ${env.internalServiceToken}`;
  if (!header || header !== expected) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }
  next();
}
