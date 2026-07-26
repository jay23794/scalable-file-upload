import 'dotenv/config';

export const env = {
  port: process.env.PORT ? Number(process.env.PORT) : 4000,
  backendBaseUrl: process.env.BACKEND_BASE_URL ?? 'http://localhost:3000',
  mlServiceUrl: process.env.ML_SERVICE_URL ?? 'http://localhost:5000',
};
