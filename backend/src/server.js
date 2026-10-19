import {
  recoverReplacement,
  replacementState,
} from './services/replacement.js';
import {
  isStorageQuotaError,
  storageQuotaMessage,
} from './services/storageErrors.js';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, storage, root } from './config.js';
import { connect, init } from './db.js';
import { auth, login, validateAuth, cookie, hash } from './services/auth.js';
import { startQueue } from './services/jobs.js';
import { dataset, importRoute } from './routes/dataset.js';
import { jobs, jobRoutes } from './routes/jobs.js';

validateAuth();

await fs.mkdir(storage, { recursive: true });

const db = await connect();

let dataReady = false;
let recoveryFailed = false;

const app = express();

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

app.locals.db = db;
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', (_, res) =>
  res.json({
    ok: true,
    dataReady,
    recoveryFailed,
  }),
);

app.post(
  '/api/login',
  rateLimit({
    windowMs: 15 * 60000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
  login,
);

app.use('/api', auth);

app.use('/api', async (req, res, next) => {
  try {
    const usesSharedData =
      req.path.startsWith('/dataset') ||
      (req.method !== 'GET' && req.path.startsWith('/jobs'));

    if (
      usesSharedData &&
      (!dataReady || (await replacementState()))
    ) {
      return res.status(503).json({
        error: recoveryFailed
          ? 'Shared data recovery failed. Check the backend terminal.'
          : 'Shared data is recovering or being updated. Please wait.',
      });
    }

    next();
  } catch (error) {
    next(error);
  }
});

app.get('/api/me', (req, res) =>
  res.json({
    username: req.user,
    csrf: req.csrf,
  }),
);

app.post('/api/logout', async (req, res) => {
  await db.collection('sessions').deleteOne({
    _id: hash(cookie(req)),
  });

  res.clearCookie('gp_session', { path: '/' }).json({
    ok: true,
  });
});

const upload = multer({
  dest: storage,
  limits: {
    fileSize: config.uploadMB * 1024 * 1024,
    files: 1,
    fields: 2,
    fieldSize: 1024 * 1024,
  },
  fileFilter: (req, file, cb) =>
    cb(
      null,
      /\.(csv|tsv|txt|xlsx|xls|jsonl)$/i.test(file.originalname),
    ),
}).single('file');

// Remove rejected uploads without touching queued files.
app.use('/api', (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400 && req.file) {
      db.collection('jobs')
        .findOne({ 'upload.path': req.file.path })
        .then((existing) => {
          if (!existing) {
            return fs.unlink(req.file.path);
          }
        })
        .catch(() => {});
    }
  });

  next();
});

importRoute(upload);
jobRoutes(upload);

app.use('/api/dataset', dataset);
app.use('/api/jobs', jobs);

app.use('/api', (req, res) =>
  res.status(404).json({
    error: 'API route not found',
  }),
);

const dist = path.resolve(root, '../frontend/dist');

app.use(express.static(dist));

app.get('/{*path}', (req, res) =>
  res.sendFile(path.join(dist, 'index.html')),
);

app.use((err, req, res, next) => {
  console.error(err.message);

  if (res.headersSent) {
    return res.destroy();
  }

  if (isStorageQuotaError(err)) {
    return res.status(507).json({
      error: storageQuotaMessage,
    });
  }

  res.status(err.status || 400).json({
    error:
      err.code === 'LIMIT_FILE_SIZE'
        ? `Upload exceeds ${config.uploadMB} MB limit`
        : err.message,
  });
});

// Start the API before restoring shared data.
app.listen(config.port, () => {
  console.log(
    `API listening on ${config.port}; login is available.`,
  );

  void (async () => {
    try {
      await recoverReplacement(db);
      await init(db);
      await startQueue(db);

      dataReady = true;

      console.log('Shared data is ready.');
    } catch (error) {
      recoveryFailed = true;

      console.error('[Recovery/startup]', error);
    }
  })();
});