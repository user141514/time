const express = require('express');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const { httpProblem, notFound, problemHandler } = require('./http/problem');
const { createRequestLifecycle } = require('./http/request-lifecycle');
const { HISTORY_SNAPSHOT_MAX_BYTES } = require('./history/limits');
const { analyzeCoaching } = require('./workflows/analyze-coaching');
const { checkGoals } = require('./workflows/check-goals');
const { checkIntake } = require('./workflows/check-intake');
const { checkTaskSmart } = require('./workflows/check-task-smart');
const { classifyMatrix } = require('./workflows/classify-matrix');
const { decomposeTasks } = require('./workflows/decompose-tasks');
const { diagnoseDistribution } = require('./workflows/diagnose-distribution');
const { extractTasks } = require('./workflows/extract-tasks');
const { generateReport } = require('./workflows/generate-report');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const DECOMPOSE_RESPONSE_MAX_BYTES = 192 * 1024;
const COACHING_REQUEST_KEYS = new Set([
  'decompositionId',
  'attemptId',
  'businessDate',
  'entries',
  'evidence',
]);

function writeLog(logger, entry) {
  if (typeof logger === 'function') logger(entry);
  else if (logger && typeof logger.info === 'function') logger.info(entry);
}

function modelRequestOptions(request, response, logger, extra = {}) {
  const context = response.locals.requestContext || {};
  return {
    signal: context.signal,
    deadlineAt: context.deadlineAt,
    onAttempt: event => writeLog(logger, {
      requestId: request.requestId,
      ...extra,
      stage: event.stage,
      attempt: event.attempt,
      responseFormat: event.responseFormat,
      fallbackUsed: event.fallbackUsed,
      status: event.status,
      durationMs: event.durationMs,
      errorCode: event.errorCode,
    }),
  };
}

function sendBoundedJson(response, value, maxBytes) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw Object.assign(new Error('AI 响应内容过大，请减少输入后重试。'), {
      code: 'API_RESPONSE_TOO_LARGE',
      status: 502,
      expose: true,
    });
  }
  response.type('application/json').send(serialized);
}

function requireMutationSecurity(authBoundary) {
  return (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    return authBoundary.requireSameOrigin(request, response, (originError) => {
      if (originError) return next(originError);
      return authBoundary.requireSessionCsrf(request, response, next);
    });
  };
}

function createTimeManagementJsonParser() {
  const standardParser = express.json({ limit: '64kb', strict: true });
  const historyParser = express.json({
    limit: HISTORY_SNAPSHOT_MAX_BYTES,
    strict: true,
  });
  return (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    const pathname = new URL(request.originalUrl, 'http://localhost').pathname;
    const parser = request.method === 'POST'
      && /^\/api\/time-management\/history\/?$/.test(pathname)
      ? historyParser
      : standardParser;
    return parser(request, response, (error) => {
      if (
        error?.type === 'entity.too.large'
        && /^\/api\/time-management\/tasks\/coaching-analysis\/?$/.test(pathname)
      ) {
        return next(httpProblem(
          'COACHING_PAYLOAD_TOO_LARGE',
          '教练诊断请求内容过大。',
          413,
        ));
      }
      return next(error);
    });
  };
}

function createApp({
  modelClient,
  authBoundary,
  logger,
  now = Date.now,
  config = {},
} = {}) {
  if (
    !authBoundary
    || typeof authBoundary.sessionMiddleware !== 'function'
    || typeof authBoundary.router !== 'function'
    || typeof authBoundary.dailyTrackingRouter !== 'function'
    || typeof authBoundary.historyRouter !== 'function'
    || typeof authBoundary.requireAuth !== 'function'
    || typeof authBoundary.requireSameOrigin !== 'function'
    || typeof authBoundary.requireSessionCsrf !== 'function'
  ) {
    throw Object.assign(new Error('A complete authBoundary is required.'), {
      code: 'CONFIG_INVALID',
    });
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.modelClient = modelClient;

  app.use((_request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use('/api', (request, response, next) => {
    const startedAt = Date.now();
    request.requestId = randomUUID();
    response.set('X-Request-Id', request.requestId);
    response.once('finish', () => {
      const entry = {
        requestId: request.requestId,
        path: new URL(request.originalUrl, 'http://localhost').pathname,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
      };
      if (response.locals.modelOutputDiagnostic) {
        if (response.locals.modelOutputDiagnostic.stage) {
          entry.modelOutputStage = response.locals.modelOutputDiagnostic.stage;
        }
        entry.modelOutputReason = response.locals.modelOutputDiagnostic.reason;
        entry.modelAttempts = response.locals.modelOutputDiagnostic.attempts;
      }
      writeLog(logger, entry);
    });
    next();
  });
  app.use('/api', createRequestLifecycle({
    modelTimeoutMs: config.modelTimeoutMs || 30_000,
    taskRouteBudgetMs: config.modelTaskRouteBudgetMs,
  }));
  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
  app.use(authBoundary.sessionMiddleware);
  app.use(
    '/api/auth',
    express.json({ limit: '64kb', strict: true }),
    authBoundary.router,
  );
  app.use('/api/time-management', authBoundary.requireAuth);
  app.use('/api/time-management', requireMutationSecurity(authBoundary));
  app.use('/api/time-management', createTimeManagementJsonParser());
  app.use('/api/time-management/daily-tracking', authBoundary.dailyTrackingRouter);
  app.use('/api/time-management/history', authBoundary.historyRouter);
  app.post('/api/time-management/intake/check', (request, response, next) => {
    try {
      response.json(checkIntake({
        entries: request.body?.entries,
        requestBody: request.body,
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/time-management/tasks/decompose', async (request, response, next) => {
    const decompositionId = randomUUID();
    try {
      const result = await decomposeTasks({
        entries: request.body?.entries,
        modelClient,
        requestBody: request.body,
        now,
        decompositionId,
        responseFormatMode: config.modelResponseFormatMode,
        maxTokens: config.modelTaskMaxOutputTokens,
        ...modelRequestOptions(request, response, logger, { decompositionId }),
      });
      sendBoundedJson(response, result, DECOMPOSE_RESPONSE_MAX_BYTES);
    } catch (error) {
      if (error?.code === 'MODEL_OUTPUT_INVALID') {
        response.locals.modelOutputDiagnostic = {
          stage: error.stage,
          reason: error.failedRules?.[0] || error.diagnosticCode || 'MODEL_JSON_INVALID',
          attempts: error.modelAttempts || 2,
        };
      }
      next(error);
    }
  });
  app.post('/api/time-management/tasks/coaching-analysis', async (request, response, next) => {
    try {
      if (
        !request.body
        || typeof request.body !== 'object'
        || Array.isArray(request.body)
        || Object.keys(request.body).some(key => !COACHING_REQUEST_KEYS.has(key))
      ) {
        throw Object.assign(new Error('教练诊断请求不符合要求。'), {
          code: 'INPUT_INVALID',
          status: 400,
          expose: true,
        });
      }
      const result = await analyzeCoaching({
        ...request.body,
        modelClient,
        responseFormatMode: config.modelResponseFormatMode,
        maxTokens: config.modelCoachMaxOutputTokens,
        ...modelRequestOptions(request, response, logger, {
          decompositionId: request.body.decompositionId,
        }),
      });
      response.json(result);
    } catch (error) {
      if (error?.code === 'MODEL_OUTPUT_INVALID') {
        response.locals.modelOutputDiagnostic = {
          stage: 'coaching-analysis',
          reason: error.failedRules?.[0] || error.diagnosticCode || 'MODEL_JSON_INVALID',
          attempts: error.modelAttempts || 2,
        };
      }
      next(error);
    }
  });
  app.post('/api/time-management/tasks/smart-check', (request, response, next) => {
    try {
      response.json(checkTaskSmart({
        tasks: request.body?.tasks,
        requestBody: request.body,
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/time-management/distribution/diagnose', (request, response, next) => {
    try {
      response.json(diagnoseDistribution({
        tasks: request.body?.tasks,
        requestBody: request.body,
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/time-management/goals/check', async (request, response, next) => {
    try {
      response.json(await checkGoals({
        goals: request.body?.goals,
        modelClient,
        requestBody: request.body,
        ...modelRequestOptions(request, response, logger),
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/time-management/tasks/extract', async (request, response, next) => {
    try {
      response.json(await extractTasks({
        goals: request.body?.goals,
        modelClient,
        requestBody: request.body,
        ...modelRequestOptions(request, response, logger),
        now,
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/time-management/matrix/classify', async (request, response, next) => {
    try {
      response.json(await classifyMatrix({
        tasks: request.body?.tasks,
        modelClient,
        requestBody: request.body,
        ...modelRequestOptions(request, response, logger),
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/time-management/report/generate', async (request, response, next) => {
    try {
      const result = await generateReport({
        tasks: request.body?.tasks,
        matrix: request.body?.matrix,
        goals: request.body?.goals,
        distribution: request.body?.distribution,
        modelClient,
        requestBody: request.body,
        now,
        ...modelRequestOptions(request, response, logger),
      });
      if (result?.degraded) {
        response.locals.modelOutputDiagnostic = {
          reason: result.degradedReason,
          attempts: result.degradedAttempts || 2,
        };
      }
      response.json(result);
    } catch (error) {
      if (error?.code === 'MODEL_OUTPUT_INVALID') {
        response.locals.modelOutputDiagnostic = {
          reason: error.diagnosticCode || 'MODEL_JSON_INVALID',
          attempts: error.modelAttempts || 1,
        };
      }
      next(error);
    }
  });
  app.use(
    '/api',
    express.json({ limit: '64kb', strict: true }),
    notFound,
  );
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
  app.use(problemHandler);

  return app;
}

module.exports = { createApp };
