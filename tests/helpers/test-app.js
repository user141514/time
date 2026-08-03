const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../../server/app');
const { createRuntime } = require('../../server/runtime');

const SESSION_SECRET = 'fake-auth-api-session-secret-with-at-least-forty-eight-bytes';

async function createAuthTestApp(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'time-auth-app-'));
  const config = {
    databasePath: path.join(directory, 'auth.sqlite'),
    sessionSecret: SESSION_SECRET,
    sessionCookieSecure: false,
    sessionMaxAgeMs: 604_800_000,
    ...options.config,
  };
  const runtimeOptions = options.now ? { now: options.now } : {};
  const runtime = await createRuntime(config, runtimeOptions);
  const app = createApp({
    modelClient: options.modelClient || { completeJson: async () => ({}) },
    authBoundary: runtime.authBoundary,
    config,
    logger: options.logger,
    ...runtimeOptions,
  });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });

  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    database: runtime.database,
    runtime,
  };
}

module.exports = { SESSION_SECRET, createAuthTestApp };
