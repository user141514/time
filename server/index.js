const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { createModelClient } = require('./model/model-client');
const { createRuntime } = require('./runtime');

async function main() {
  const config = loadConfig(process.env);
  const runtime = await createRuntime(config);
  const app = createApp({
    modelClient: createModelClient(config),
    authBoundary: runtime.authBoundary,
    logger: entry => process.stdout.write(`${JSON.stringify(entry)}\n`),
    config,
  });

  const server = app.listen(config.port, '127.0.0.1', () => {
    process.stdout.write(`Time assistant listening on http://127.0.0.1:${config.port}\n`);
  });
  server.once('error', async () => {
    await runtime.close().catch(() => undefined);
  });

  process.once('SIGTERM', () => shutdown({ signal: 'SIGTERM', server, runtime }));
  process.once('SIGINT', () => shutdown({ signal: 'SIGINT', server, runtime }));
}

async function shutdown({ signal, server, runtime }) {
  process.stderr.write(`Time assistant shutting down (${signal})...\n`);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await runtime.close().catch(() => undefined);
  process.exitCode = 0;
}

main().catch((error) => {
  const detail = error?.message ? `: ${error.message}` : '';
  process.stderr.write(`Time assistant failed to start${detail}.\n`);
  process.exitCode = 1;
});
