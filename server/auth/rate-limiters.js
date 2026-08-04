const { ipKeyGenerator, rateLimit } = require('express-rate-limit');

const { httpProblem } = require('../http/problem');
const { normalizeUsername } = require('./username');

const WINDOW_MS = 15 * 60 * 1000;

function usernameKey(value) {
  try {
    return normalizeUsername(value);
  } catch {
    // ponytail: all unparseable usernames share one bucket — blocks rotation attacks
    // but also buckets legitimate typos together; per-IP fallback if false positives appear
    return 'invalid-username';
  }
}

function createLimiter(limit) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (request) => `${ipKeyGenerator(request.ip)}:${usernameKey(request.body?.username)}`,
    handler: (_request, _response, next) => next(httpProblem(
      'AUTH_RATE_LIMITED',
      '尝试过于频繁，请稍后再试。',
      429,
    )),
  });
}

function createAuthRateLimiters() {
  return Object.freeze({
    register: createLimiter(5),
    login: createLimiter(10),
    reset: createLimiter(5),
  });
}

module.exports = { WINDOW_MS, createAuthRateLimiters };
