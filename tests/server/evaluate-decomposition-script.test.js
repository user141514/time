const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createLiveEvaluationContext,
  parseArgs,
} = require('../../scripts/evaluate-decomposition');

test('live eval 上下文把结构化输出和思考模式配置传给模型客户端', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = {
      url,
      headers: options.headers,
      body: JSON.parse(options.body),
    };
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: '{"ok":true}' },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const context = createLiveEvaluationContext({
    environment: {
      MODEL_API_BASE_URL: 'https://model.example/v1/',
      MODEL_API_KEY: 'fake-key',
      MODEL_NAME: 'fake-model',
      MODEL_TIMEOUT_MS: '31000',
      MODEL_RESPONSE_FORMAT_MODE: 'json_object',
      MODEL_THINKING_MODE: 'disabled',
      MODEL_TASK_ROUTE_BUDGET_MS: '32000',
      MODEL_TASK_MAX_OUTPUT_TOKENS: '12000',
      MODEL_COACH_MAX_OUTPUT_TOKENS: '6000',
    },
    fetchImpl,
  });

  const result = await context.modelClient.completeJson({
    system: 'Return JSON.',
    user: 'Confirm.',
    maxAttempts: 1,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(request.url, 'https://model.example/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer fake-key');
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.deepEqual(context.diagnostics, {
    modelName: 'fake-model',
    responseFormatMode: 'json_object',
  });
  assert.equal(Object.hasOwn(context, 'config'), false);
  assert.deepEqual(context.requestOptions, {
    responseFormatMode: 'json_object',
    maxTokens: 12000,
    taskRouteBudgetMs: 32000,
  });
});

test('live eval CLI 参数解析保留 case 选择和回归失败开关', () => {
  assert.deepEqual(parseArgs([
    '--mode=live',
    '--case=D001',
    '--case=D017',
    '--json',
    '--fail-on-regression',
  ]), {
    mode: 'live',
    dataset: require('node:path').join(
      __dirname,
      '..',
      '..',
      'tests',
      'evals',
      'decomposition-cases.jsonl',
    ),
    json: true,
    failOnRegression: true,
    caseIds: ['D001', 'D017'],
  });
});
