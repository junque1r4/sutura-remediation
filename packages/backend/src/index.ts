import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { loadConfig, getConfig } from './config';
import { authMiddleware } from './middleware/auth';
import { auditMiddleware } from './middleware/audit';
import { errorHandler } from './middleware/error-handler';
import { findingsRouter } from './routes/findings';
import { fixesRouter } from './routes/fixes';
import { organizationsRouter } from './routes/organizations';
import { repositoriesRouter } from './routes/repositories';
import { auditLogRouter } from './routes/audit-log';
import { webhooksRouter } from './routes/webhooks';
import { tokenUsageRouter, internalTokenUsageRouter } from './routes/token-usage';
import { analyticsRouter, internalAnalyticsRouter } from './routes/analytics';
import { validatedFixRouter } from './routes/validated-fix';
import { connectionsRouter, internalConnectionsRouter } from './routes/connections';
import { repoPromptsRouter } from './routes/repo-prompts';
import { internalAnalysisRouter } from './routes/analysis';
import { syncRouter } from './routes/sync';
import { startScannerSyncPoller } from './sync/poller';
import { startFixWorker } from './queue/workers/fix-worker';
import { startIndexWorker } from './queue/workers/index-worker';
import { startValidationWorker } from './queue/workers/validation-worker';
import { runMigrations } from './db/migrate';
import { getSingletonOrgId } from './db/organizations';

// The validation worker runs in THIS process (startValidationWorker below), and
// it talks to the docker-socket-proxy via dockerode. A sandbox upload/exec whose
// connection dies mid-write surfaces as a late 'error' (EPIPE/ECONNRESET) on a
// socket with no listener -- an unhandled one would crash the whole process and
// take the HTTP API down with it (observed as dashboard 500s / ECONNREFUSED).
// Swallow exactly those transient socket errors so a single fix job can't kill
// the backend; the affected job still fails cleanly via the putArchive/exec
// timeouts -> orchestrator catch. Anything else is genuinely unexpected: log and
// exit so the orchestrator restarts from a known-good state.
const TRANSIENT_SOCKET_CODES = new Set(['EPIPE', 'ECONNRESET']);
process.on('uncaughtException', (err) => {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code && TRANSIENT_SOCKET_CODES.has(code)) {
    console.error(`[backend] ignored transient socket error (${code}) from sandbox/docker path:`, err.message);
    return;
  }
  console.error('[backend] fatal uncaughtException, exiting:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[backend] unhandledRejection:', reason);
});

loadConfig();
const app = express();
const config = getConfig();

app.use(helmet());

// Accept the configured DASHBOARD_URL plus the localhost variant (the user's
// browser hits localhost:3000 even when the container is reachable as
// http://dashboard:3000 from inside the docker network).
const allowedOrigins = new Set(
  [config.DASHBOARD_URL, 'http://localhost:3000', 'http://127.0.0.1:3000'].filter(Boolean),
);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);
// Capture the raw request bytes so webhook routes can verify HMAC signatures
// over the exact transmitted payload (not a re-serialized copy).
app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

// Health check (no auth)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhooks -- before auth middleware
app.use('/webhooks', webhooksRouter);

// Authenticated routes
app.use('/api', authMiddleware);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use('/api', auditMiddleware as any);

// Internal dashboard-proxied routes -- now JWT-authenticated (same signed
// HS256 token as /api). Mounted behind authMiddleware so req.orgId is set
// from verified claims; the legacy x-internal-secret path is gone.
app.use('/internal', authMiddleware, internalTokenUsageRouter);
app.use('/internal', authMiddleware, internalAnalyticsRouter);
app.use('/internal', authMiddleware, internalConnectionsRouter);
app.use('/internal', authMiddleware, internalAnalysisRouter);
app.use('/api/findings', findingsRouter);
app.use('/api/fixes', fixesRouter);
app.use('/api/org', organizationsRouter);
app.use('/api/repositories', repositoriesRouter);
app.use('/api/audit-log', auditLogRouter);
app.use('/api/token-usage', tokenUsageRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/repo-prompts', repoPromptsRouter);
app.use('/api/sync', syncRouter);
app.use('/api', validatedFixRouter);

app.use(errorHandler);

runMigrations()
  // Fail-fast on the single-tenant invariant: there must be exactly one
  // organization row. getSingletonOrgId() throws otherwise and memoizes the
  // resolved id for the rest of the process (e.g. webhook ingestion).
  .then(() => getSingletonOrgId())
  .then(() => {
    startFixWorker();
    startIndexWorker();
    startValidationWorker();
    console.warn('BullMQ workers started');

    // Outbound scanner sync poll (default-off; guarded by SCANNER_SYNC_ENABLED).
    startScannerSyncPoller();

    app.listen(config.PORT, () => {
      console.warn(`Sutura backend running on port ${config.PORT}`);
    });
  })
  .catch((err) => {
    console.error('[migrate] failed', err);
    process.exit(1);
  });

export default app;
