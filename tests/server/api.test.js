const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestAuthBoundary } = require('../helpers/test-auth-boundary');

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

test('GET /api/health 返回 ok 且隐藏 Express 标识', async () => {
  const { createApp } = require('../../server/app');
  const app = createApp({
    authBoundary: createTestAuthBoundary(),
    modelClient: { completeJson: async () => ({}) },
  });
  const server = await listen(app);

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await close(server);
  }
});

test('GET / 从同一服务返回前端页面', async () => {
  const { createApp } = require('../../server/app');
  const app = createApp({
    authBoundary: createTestAuthBoundary(),
    modelClient: { completeJson: async () => ({}) },
  });
  const server = await listen(app);

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>时间管理助手/);
  } finally {
    await close(server);
  }
});

test('未知 API 返回安全统一错误结构', async () => {
  const { createApp } = require('../../server/app');
  const app = createApp({
    authBoundary: createTestAuthBoundary(),
    modelClient: { completeJson: async () => ({}) },
  });
  const server = await listen(app);

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/missing`);
    const payload = await response.json();
    assert.equal(response.status, 404);
    assert.equal(payload.error.code, 'NOT_FOUND');
    assert.equal(payload.error.message, '请求的接口不存在。');
    assert.match(payload.error.requestId, /^[0-9a-f-]{36}$/i);
    assert.equal('stack' in payload.error, false);
  } finally {
    await close(server);
  }
});

test('未知 API 仍限制 JSON 请求体大小', async () => {
  const { createApp } = require('../../server/app');
  const app = createApp({
    authBoundary: createTestAuthBoundary(),
    modelClient: { completeJson: async () => ({}) },
  });
  const server = await listen(app);

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(65 * 1024) }),
    });
    const payload = await response.json();
    assert.equal(response.status, 413);
    assert.equal(payload.error.code, 'PAYLOAD_TOO_LARGE');
    assert.doesNotMatch(JSON.stringify(payload), /stack|x{100}/i);
  } finally {
    await close(server);
  }
});

test('loadModelConfig 可独立加载 live eval 所需模型配置', () => {
  const { loadModelConfig } = require('../../server/config');
  const config = loadModelConfig({
    MODEL_API_BASE_URL: 'https://model.example/v1/',
    MODEL_API_KEY: 'fake-key',
    MODEL_NAME: 'fake-model',
    MODEL_TIMEOUT_MS: '31000',
    MODEL_RESPONSE_FORMAT_MODE: 'json_object',
    MODEL_THINKING_MODE: 'disabled',
    MODEL_TASK_ROUTE_BUDGET_MS: '32000',
    MODEL_TASK_MAX_OUTPUT_TOKENS: '12000',
    MODEL_COACH_MAX_OUTPUT_TOKENS: '6000',
  });

  assert.deepEqual(config, {
    modelApiBaseUrl: 'https://model.example/v1',
    modelApiKey: 'fake-key',
    modelName: 'fake-model',
    modelTimeoutMs: 31000,
    modelResponseFormatMode: 'json_object',
    modelThinkingMode: 'disabled',
    modelTaskRouteBudgetMs: 32000,
    modelTaskMaxOutputTokens: 12000,
    modelCoachMaxOutputTokens: 6000,
  });
});

test('loadConfig 只接受完整且有效的服务端配置', () => {
  const { loadConfig } = require('../../server/config');
  const config = loadConfig({
    PORT: '4174',
    MODEL_API_BASE_URL: 'https://model.example/v1',
    MODEL_API_KEY: 'fake-key',
    MODEL_NAME: 'fake-model',
    MODEL_TIMEOUT_MS: '30000',
    DATABASE_PATH: './data/test.sqlite',
    SESSION_SECRET: 'fake-session-secret-with-at-least-forty-eight-bytes-000000',
    SESSION_COOKIE_SECURE: 'false',
    SESSION_MAX_AGE_MS: '604800000',
  });

  assert.deepEqual(config, {
    port: 4174,
    modelApiBaseUrl: 'https://model.example/v1',
    modelApiKey: 'fake-key',
    modelName: 'fake-model',
    modelTimeoutMs: 30000,
    modelResponseFormatMode: 'auto',
    modelThinkingMode: 'default',
    modelTaskRouteBudgetMs: 12_000,
    modelTaskMaxOutputTokens: 16_384,
    modelCoachMaxOutputTokens: 8_192,
    databasePath: './data/test.sqlite',
    sessionSecret: 'fake-session-secret-with-at-least-forty-eight-bytes-000000',
    sessionCookieSecure: false,
    sessionMaxAgeMs: 604800000,
  });
  assert.throws(
    () => loadConfig({}),
    error => error.code === 'CONFIG_INVALID' && !String(error.message).includes('undefined'),
  );
  assert.throws(
    () => loadConfig({
      MODEL_API_BASE_URL: 'https://model.example/v1',
      MODEL_API_KEY: 'fake-key',
      MODEL_NAME: 'fake-model',
      DATABASE_PATH: './data/test.sqlite',
      SESSION_SECRET: 'too-short',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_MAX_AGE_MS: '604800000',
    }),
    error => error.code === 'CONFIG_INVALID' && /SESSION_SECRET/.test(error.message),
  );
  assert.throws(
    () => loadConfig({
      MODEL_API_BASE_URL: 'https://model.example/v1',
      MODEL_API_KEY: 'fake-key',
      MODEL_NAME: 'fake-model',
      DATABASE_PATH: './data/test.sqlite',
      SESSION_SECRET: 'fake-session-secret-with-at-least-forty-eight-bytes-000000',
      SESSION_COOKIE_SECURE: 'sometimes',
      SESSION_MAX_AGE_MS: '604800000',
    }),
    error => error.code === 'CONFIG_INVALID' && /SESSION_COOKIE_SECURE/.test(error.message),
  );
  assert.throws(
    () => loadConfig({
      MODEL_API_BASE_URL: 'https://model.example/v1',
      MODEL_API_KEY: 'fake-key',
      MODEL_NAME: 'fake-model',
      DATABASE_PATH: './data/test.sqlite',
      SESSION_SECRET: 'fake-session-secret-with-at-least-forty-eight-bytes-000000',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_MAX_AGE_MS: '86400000',
    }),
    error => error.code === 'CONFIG_INVALID' && /SESSION_MAX_AGE_MS/.test(error.message),
  );
  assert.throws(
    () => loadConfig({
      MODEL_API_BASE_URL: 'https://model.example/v1',
      MODEL_API_KEY: 'fake-key',
      MODEL_NAME: 'fake-model',
      MODEL_THINKING_MODE: 'sometimes',
      DATABASE_PATH: './data/test.sqlite',
      SESSION_SECRET: 'fake-session-secret-with-at-least-forty-eight-bytes-000000',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_MAX_AGE_MS: '604800000',
    }),
    error => error.code === 'CONFIG_INVALID' && /MODEL_THINKING_MODE/.test(error.message),
  );
  assert.throws(
    () => loadConfig({
      MODEL_API_BASE_URL: 'https://model.example/v1',
      MODEL_API_KEY: 'fake-key',
      MODEL_NAME: 'fake-model',
      MODEL_TASK_ROUTE_BUDGET_MS: '120001',
      DATABASE_PATH: './data/test.sqlite',
      SESSION_SECRET: 'fake-session-secret-with-at-least-forty-eight-bytes-000000',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_MAX_AGE_MS: '604800000',
    }),
    error => error.code === 'CONFIG_INVALID' && /MODEL_TASK_ROUTE_BUDGET_MS/.test(error.message),
  );
  assert.throws(
    () => loadConfig({
      MODEL_API_BASE_URL: 'https://model.example/v1',
      MODEL_API_KEY: 'fake-key',
      MODEL_NAME: 'fake-model',
      MODEL_RESPONSE_FORMAT_MODE: 'xml',
      DATABASE_PATH: './data/test.sqlite',
      SESSION_SECRET: 'fake-session-secret-with-at-least-forty-eight-bytes-000000',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_MAX_AGE_MS: '604800000',
    }),
    error => error.code === 'CONFIG_INVALID' && /MODEL_RESPONSE_FORMAT_MODE/.test(error.message),
  );
});
