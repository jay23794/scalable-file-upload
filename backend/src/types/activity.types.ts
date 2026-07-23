import { Document } from "mongoose";

export interface IActivitySession extends Document {
  id?: string;
  userId?: string;
  userEmail: string;
  isStarted: boolean;
  avatar?: string;
}
