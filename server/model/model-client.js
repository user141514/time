const { performance } = require('node:perf_hooks');
const { parseModelJson } = require('./parse-model-json');
const {
  abortError,
  raceWithSignal,
  readLimitedBody,
} = require('./read-limited-body');

const MODEL_ENVELOPE_MAX_BYTES = 96 * 1024;
const MODEL_ERROR_BODY_MAX_BYTES = 8 * 1024;
const RESPONSE_FORMAT_MODES = new Set(['auto', 'json_schema', 'json_object']);
const THINKING_MODES = new Set(['default', 'enabled', 'disabled']);
const RESPONSE_FORMAT_ERROR_CODES = new Set([
  'unsupported_response_format',
  'unsupported_value',
]);

function modelError(code, message) {
  return Object.assign(new Error(message), { code });
}

function invalidEnvelopeError() {
  return Object.assign(new Error('model output is invalid'), {
    code: 'MODEL_OUTPUT_INVALID',
    diagnosticCode: 'MODEL_RESPONSE_ENVELOPE_INVALID',
  });
}

function normalizeMaxAttempts(value) {
  const attempts = value == null ? 2 : Number(value);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 2) {
    throw modelError('MODEL_CONFIG_INVALID', 'maxAttempts must be 1 or 2');
  }
  return attempts;
}

function normalizePositiveInteger(value, name, fallback) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw modelError('MODEL_CONFIG_INVALID', `${name} must be a positive integer`);
  }
  return candidate;
}

function normalizeResponseFormatMode(value) {
  const mode = value == null ? 'auto' : String(value);
  if (!RESPONSE_FORMAT_MODES.has(mode)) {
    throw modelError('MODEL_CONFIG_INVALID', 'responseFormatMode is invalid');
  }
  return mode;
}

function normalizeThinkingMode(value) {
  const mode = value == null ? 'default' : String(value);
  if (!THINKING_MODES.has(mode)) {
    throw modelError('MODEL_CONFIG_INVALID', 'thinkingMode is invalid');
  }
  return mode;
}

function normalizeFinishReason(value) {
  if (value === 'length' || value === 'content_filter' || value === 'stop') {
    return value;
  }
  return 'other';
}

function safeAbortReason(signal) {
  return signal?.reason?.code === 'MODEL_TIMEOUT'
    ? modelError('MODEL_TIMEOUT', 'model request timed out')
    : modelError('MODEL_CANCELLED', 'model request cancelled');
}

function createOperation({ externalSignal, deadlineAt, timeoutMs, now }) {
  const controller = new AbortController();
  const configuredDeadline = now() + timeoutMs;
  const routeDeadline = Number.isFinite(deadlineAt) ? deadlineAt : Infinity;
  const effectiveDeadline = Math.min(configuredDeadline, routeDeadline);

  const abortFromCaller = () => {
    if (!controller.signal.aborted) controller.abort(safeAbortReason(externalSignal));
  };
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (externalSignal?.aborted) abortFromCaller();

  let timer;
  const remainingMs = effectiveDeadline - now();
  if (!controller.signal.aborted && remainingMs <= 0) {
    controller.abort(modelError('MODEL_TIMEOUT', 'model request timed out'));
  } else if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(modelError('MODEL_TIMEOUT', 'model request timed out'));
      }
    }, remainingMs);
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function isCapabilityError(status, payload) {
  return [400, 422].includes(status)
    && ['response_format', 'json_schema'].includes(payload?.error?.param)
    && RESPONSE_FORMAT_ERROR_CODES.has(payload?.error?.code);
}

function createModelClient({
  modelApiBaseUrl,
  modelApiKey,
  modelName,
  modelTimeoutMs,
  modelResponseFormatMode = 'auto',
  modelThinkingMode = 'default',
  fetchImpl = globalThis.fetch,
  now = () => performance.now(),
}) {
  if (typeof fetchImpl !== 'function') {
    throw modelError('MODEL_CONFIG_INVALID', 'fetch implementation is required');
  }

  const endpoint = `${String(modelApiBaseUrl).replace(/\/+$/, '')}/chat/completions`;
  const configuredMode = normalizeResponseFormatMode(modelResponseFormatMode);
  const configuredThinkingMode = normalizeThinkingMode(modelThinkingMode);
  let cachedAutoMode;
  let cachedAutoModeCallCount = 0;

  function responseFormats(responseSchema, responseSchemaName, requestedMode) {
    const mode = normalizeResponseFormatMode(requestedMode ?? configuredMode);
    const jsonObject = { type: 'json_object' };
    // ponytail: re-probe json_schema every 50 calls in case the provider upgraded.
    // One extra failure per 50 calls is cheap insurance against permanent degradation.
    if (cachedAutoMode === 'json_object' && cachedAutoModeCallCount >= 50) {
      cachedAutoMode = undefined;
      cachedAutoModeCallCount = 0;
    }
    if (!responseSchema || mode === 'json_object' || cachedAutoMode === 'json_object') {
      if (cachedAutoMode === 'json_object') cachedAutoModeCallCount += 1;
      return [jsonObject];
    }
    const strict = {
      type: 'json_schema',
      json_schema: {
        name: responseSchemaName || 'structured_response',
        strict: true,
        schema: responseSchema,
      },
    };
    return mode === 'json_schema' ? [strict] : [strict, jsonObject];
  }

  async function completeJson({
    system,
    user,
    temperature = 0.2,
    maxAttempts = 2,
    responseSchema,
    responseSchemaName,
    signal,
    deadlineAt,
    responseFormatMode,
    maxTokens,
    maxContentBytes = 64 * 1024,
    onAttempt = () => undefined,
  }) {
    const attempts = normalizeMaxAttempts(maxAttempts);
    const contentLimit = normalizePositiveInteger(
      maxContentBytes,
      'maxContentBytes',
      64 * 1024,
    );
    const outputTokens = maxTokens == null
      ? undefined
      : normalizePositiveInteger(maxTokens, 'maxTokens');
    const operation = createOperation({
      externalSignal: signal,
      deadlineAt,
      timeoutMs: modelTimeoutMs,
      now,
    });
    let upstreamAttempt = 0;

    function emitAttempt(event) {
      try {
        onAttempt(Object.freeze(event));
      } catch {
        // Instrumentation must not change request behavior.
      }
    }

    async function fetchFormat(responseFormat, fallbackUsed) {
      upstreamAttempt += 1;
      const attempt = upstreamAttempt;
      const startedAt = now();
      let status = 0;
      let response;
      const requestSystem = responseSchema && responseFormat.type === 'json_object'
        ? `${system}\n\n输出必须严格符合以下 JSON Schema；字段名、嵌套结构、必填字段和枚举值不得改写或省略：\n<response_json_schema>${JSON.stringify(responseSchema)}</response_json_schema>`
        : system;
      const requestBody = {
        model: modelName,
        temperature,
        response_format: responseFormat,
        messages: [
          { role: 'system', content: requestSystem },
          { role: 'user', content: user },
        ],
      };
      if (outputTokens !== undefined) requestBody.max_tokens = outputTokens;
      if (configuredThinkingMode !== 'default') {
        requestBody.thinking = { type: configuredThinkingMode };
      }

      try {
        response = await raceWithSignal(fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${modelApiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: operation.signal,
        }), operation.signal);
        status = Number(response?.status) || 0;
      } catch (error) {
        const safeError = operation.signal.aborted
          ? abortError(operation.signal)
          : modelError('MODEL_UPSTREAM_ERROR', 'model request failed');
        emitAttempt({
          attempt,
          responseFormat: responseFormat.type,
          fallbackUsed,
          status,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          errorCode: safeError.code,
        });
        throw safeError;
      }

      let text;
      try {
        text = await readLimitedBody(
          response,
          response?.ok === true
            ? MODEL_ENVELOPE_MAX_BYTES
            : MODEL_ERROR_BODY_MAX_BYTES,
          {
            signal: operation.signal,
            tooLargeCode: response?.ok === true
              ? 'MODEL_RESPONSE_ENVELOPE_TOO_LARGE'
              : 'MODEL_ERROR_BODY_TOO_LARGE',
          },
        );
      } catch (error) {
        let safeError;
        if (operation.signal.aborted) {
          safeError = abortError(operation.signal);
        } else if ([
          'MODEL_RESPONSE_ENVELOPE_TOO_LARGE',
          'MODEL_ERROR_BODY_TOO_LARGE',
        ].includes(error?.code)) {
          safeError = modelError(error.code, 'model response body too large');
        } else {
          safeError = invalidEnvelopeError();
        }
        emitAttempt({
          attempt,
          responseFormat: responseFormat.type,
          fallbackUsed,
          status,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          errorCode: safeError.diagnosticCode || safeError.code,
        });
        throw safeError;
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        if (response?.ok !== true) payload = null;
        else {
          const error = invalidEnvelopeError();
          emitAttempt({
            attempt,
            responseFormat: responseFormat.type,
            fallbackUsed,
            status,
            durationMs: Math.max(0, Math.round(now() - startedAt)),
            errorCode: error.diagnosticCode,
          });
          throw error;
        }
      }

      if (response?.ok !== true) {
        const capabilityError = isCapabilityError(status, payload);
        emitAttempt({
          attempt,
          responseFormat: responseFormat.type,
          fallbackUsed,
          status,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          errorCode: capabilityError
            ? 'MODEL_RESPONSE_FORMAT_UNSUPPORTED'
            : 'MODEL_UPSTREAM_ERROR',
        });
        return { capabilityError };
      }

      try {
        const choice = payload?.choices?.[0];
        const value = parseModelJson(choice?.message?.content, {
          finishReason: normalizeFinishReason(choice?.finish_reason),
          maxBytes: contentLimit,
        });
        emitAttempt({
          attempt,
          responseFormat: responseFormat.type,
          fallbackUsed,
          status,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          errorCode: null,
        });
        return { value };
      } catch (error) {
        emitAttempt({
          attempt,
          responseFormat: responseFormat.type,
          fallbackUsed,
          status,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          errorCode: error.diagnosticCode || error.code || 'MODEL_OUTPUT_INVALID',
        });
        throw error;
      }
    }

    async function requestOnce() {
      const formats = responseFormats(
        responseSchema,
        responseSchemaName,
        responseFormatMode,
      );
      for (let index = 0; index < formats.length; index += 1) {
        const result = await fetchFormat(formats[index], index > 0);
        if (Object.hasOwn(result, 'value')) return result.value;
        const canFallback = index === 0
          && formats.length > 1
          && result.capabilityError;
        if (!canFallback) {
          throw modelError('MODEL_UPSTREAM_ERROR', 'model request failed');
        }
        cachedAutoMode = 'json_object';
        cachedAutoModeCallCount = 0;
      }
      throw modelError('MODEL_UPSTREAM_ERROR', 'model request failed');
    }

    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await requestOnce();
        } catch (error) {
          if (error.code !== 'MODEL_OUTPUT_INVALID' || attempt === attempts) throw error;
        }
      }
      throw modelError('MODEL_OUTPUT_INVALID', 'model output is invalid');
    } finally {
      operation.cleanup();
    }
  }

  return Object.freeze({ completeJson });
}

module.exports = {
  MODEL_ENVELOPE_MAX_BYTES,
  MODEL_ERROR_BODY_MAX_BYTES,
  createModelClient,
};
