import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const storage = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(root, 'storage');
export const config = {
  port: Number(process.env.PORT || 4000),
  uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/global_patterns',
  uploadMB: Math.max(1, Number(process.env.MAX_UPLOAD_MB || 200)),
  workerMB: Math.max(128, Number(process.env.MAX_WORKER_MB || 384)),
  timeout: Number(process.env.JOB_TIMEOUT_MINUTES || 30) * 60000,
  retention: Number(process.env.JOB_RETENTION_HOURS || 24) * 3600000,
};
