import mongoose from 'mongoose';
import { env } from '../config/env';

export async function connectMongo(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  await mongoose.connect(env.mongo.uri);
  console.log(`[mongo] connected to ${env.mongo.uri}`);
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  console.log('[mongo] disconnected');
}
