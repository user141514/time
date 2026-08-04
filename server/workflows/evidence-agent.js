const { performance } = require('node:perf_hooks');
const { loadVersionedPrompt } = require('../prompts/load-versioned-prompt');
const { splitEntries } = require('./check-intake');
const {
  EVIDENCE_RESPONSE_SCHEMA,
  assertFactAtomTrace,
  assertNoAtomIdDuplicates,
  validateEvidenceResponse,
} = require('./evidence-contracts');

const PROMPT_ID = 'decomposition.evidence-agent';
const STAGE = 'evidence-agent';

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
    return Object.assign(outputError(stage), { diagnosticCode: error.diagnosticCode });
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
  return !Number.isFinite(deadlineAt) || deadlineAt - monotonicNow() >= 2_000;
}

function plainTextMapping(source) {
  const characters = [];
  const rawIndexes = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '<') {
      const close = source.indexOf('>', index + 1);
      if (close >= 0) {
        index = close;
        continue;
      }
    }
    characters.push(source[index]);
    rawIndexes.push(index);
  }
  return { plain: characters.join(''), rawIndexes };
}

function stripMarkup(value) {
  return String(value || '').replace(/<[^>]*>/gu, '');
}

function restoreMarkupQuote(sourceLine, quote) {
  if (sourceLine.includes(quote)) return quote;
  if (!sourceLine.includes('<') || !sourceLine.includes('>')) return quote;
  const quotePlain = stripMarkup(quote);
  if (!quotePlain) return quote;
  const mapping = plainTextMapping(sourceLine);
  const plainIndex = mapping.plain.indexOf(quotePlain);
  if (plainIndex < 0) return quote;
  const rawStart = mapping.rawIndexes[plainIndex];
  const rawEnd = mapping.rawIndexes[plainIndex + quotePlain.length - 1];
  if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return quote;
  return sourceLine.slice(rawStart, rawEnd + 1);
}

function restoreMarkupQuotes(response, lines) {
  if (!Array.isArray(response?.atoms)) return response;
  return {
    ...response,
    atoms: response.atoms.map(atom => {
      const sourceLine = lines[atom.sourceLineIndex];
      if (typeof sourceLine !== 'string' || typeof atom.quote !== 'string') return atom;
      return { ...atom, quote: restoreMarkupQuote(sourceLine, atom.quote) };
    }),
  };
}

function validateAtoms(response, dimension, lines) {
  if (
    !response
    || typeof response !== 'object'
    || Array.isArray(response)
    || response.dimension !== dimension
    || response.atoms?.some(atom => atom.dimension !== dimension)
  ) {
    throw outputError(STAGE, ['EVIDENCE_DIMENSION_MISMATCH']);
  }
  const normalizedResponse = restoreMarkupQuotes(response, lines);
  if (!validateEvidenceResponse(normalizedResponse)) {
    throw outputError(STAGE, ['EVIDENCE_SCHEMA_INVALID']);
  }
  assertNoAtomIdDuplicates(normalizedResponse.atoms);
  assertFactAtomTrace(normalizedResponse.atoms, lines);
  return normalizedResponse;
}

async function runEvidenceAgent({
  dimension,
  entries,
  businessDate,
  modelClient,
  signal,
  deadlineAt,
  responseFormatMode,
  maxTokens,
  onAttempt,
  monotonicNow = () => performance.now(),
}) {
  const prompt = loadVersionedPrompt(PROMPT_ID);
  const attemptEvents = [];
  let modelCalls = 0;
  const startedAt = monotonicNow();
  const lines = splitEntries(entries?.[dimension]);

  const recordAttempt = event => {
    attemptEvents.push(event);
    try {
      onAttempt?.({ ...event, stage: STAGE });
    } catch {
      // Logging must not affect generation.
    }
  };

  async function invoke({ input, schema, schemaName }) {
    modelCalls += 1;
    try {
      return await modelClient.completeJson({
        system: prompt.text,
        user: JSON.stringify(input),
        temperature: 0.1,
        maxAttempts: 1,
        responseSchema: schema,
        responseSchemaName: schemaName,
        signal,
        deadlineAt,
        responseFormatMode,
        maxTokens,
        maxContentBytes: 64 * 1024,
        onAttempt: recordAttempt,
      });
    } catch (error) {
      throw normalizeModelError(error, STAGE);
    }
  }

  const baseInput = { dimension, entries, businessDate };
  let response;
  try {
    response = validateAtoms(
      await invoke({
        input: baseInput,
        schema: EVIDENCE_RESPONSE_SCHEMA,
        schemaName: 'time_evidence_atomization_v1',
      }),
      dimension,
      lines,
    );
  } catch (error) {
    if (error.code !== 'MODEL_OUTPUT_INVALID' || !canRetry(deadlineAt, monotonicNow)) {
      throw error;
    }
    const failedRules = error.failedRules?.length
      ? error.failedRules
      : [error.diagnosticCode || 'MODEL_JSON_INVALID'];
    const corrected = await invoke({
      input: {
        ...baseInput,
        retryFeedback: {
          failedRules,
          correction: '重新生成完整 atoms JSON，逐行修正。',
        },
      },
      schema: EVIDENCE_RESPONSE_SCHEMA,
      schemaName: 'time_evidence_atomization_v1',
    });
    response = validateAtoms(corrected, dimension, lines);
  }

  const successfulAttempt = [...attemptEvents]
    .reverse()
    .find(event => !event.errorCode);
  return {
    dimension,
    atoms: response.atoms,
    attempts: Math.max(modelCalls, attemptEvents.length),
    durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
    responseFormat: successfulAttempt?.responseFormat
      || (responseFormatMode === 'json_object' ? 'json_object' : 'json_schema'),
  };
}

module.exports = { runEvidenceAgent };
