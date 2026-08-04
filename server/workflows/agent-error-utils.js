// Retry deadline buffer (must leave ≥2s for a retry round-trip)
const RETRY_DEADLINE_MS = 2_000;

function publicError(code, message, status) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function outputError(stage, failedRules = []) {
  return Object.assign(
    publicError('MODEL_OUTPUT_INVALID', 'AI 返回格式异常，请重试。', 502),
    { stage, failedRules },
  );
}

function normalizeModelError(error, stage) {
  if (error.code === 'MODEL_OUTPUT_INVALID') {
    return Object.assign(
      outputError(stage, error.failedRules),
      { diagnosticCode: error.diagnosticCode },
    );
  }
  if (error.code === 'MODEL_TIMEOUT') {
    return publicError('MODEL_TIMEOUT', 'AI 响应超时，请重试。', 504);
  }
  if (error.code === 'MODEL_CANCELLED') {
    return publicError('REQUEST_CANCELLED', '请求已取消。', 499);
  }
  if ([
    'MODEL_UPSTREAM_ERROR',
    'MODEL_RESPONSE_ENVELOPE_TOO_LARGE',
    'MODEL_ERROR_BODY_TOO_LARGE',
  ].includes(error.code)) {
    return publicError('MODEL_UPSTREAM_ERROR', 'AI 服务暂时不可用，请稍后重试。', 502);
  }
  return error;
}

function canRetry(deadlineAt, monotonicNow) {
  return !Number.isFinite(deadlineAt) || deadlineAt - monotonicNow() >= RETRY_DEADLINE_MS;
}

module.exports = { publicError, outputError, normalizeModelError, canRetry };
