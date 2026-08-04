const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const DEFINITIONS = Object.freeze({
  'decomposition.coach-analysis': Object.freeze({
    version: '1.0.0',
    relativePath: 'decomposition/coach-analysis.v1.md',
  }),
  'decomposition.task-generation': Object.freeze({
    version: '1.1.0',
    relativePath: 'decomposition/task-generation.v1.1.md',
  }),
  'decomposition.evidence-task-generation': Object.freeze({
    version: '2.1.0',
    relativePath: 'decomposition/evidence-task-generation.v2.1.md',
  }),
  'decomposition.coaching-analysis': Object.freeze({
    version: '2.0.0',
    relativePath: 'decomposition/coaching-analysis.v2.md',
  }),
  'decomposition.evidence-agent': Object.freeze({
    version: '1.0.0',
    relativePath: 'decomposition/evidence-agent.v1.md',
  }),
  'decomposition.reconciliation': Object.freeze({
    version: '1.0.0',
    relativePath: 'decomposition/reconciliation.v1.md',
  }),
  'decomposition.critic-owner': Object.freeze({
    version: '1.0.0',
    relativePath: 'decomposition/critic-owner.v1.md',
  }),
  'decomposition.critic-due': Object.freeze({
    version: '1.0.0',
    relativePath: 'decomposition/critic-due.v1.md',
  }),
  'decomposition.critic-coverage': Object.freeze({
    version: '1.0.0',
    relativePath: 'decomposition/critic-coverage.v1.md',
  }),
  'decomposition.critic-dedupe': Object.freeze({
    version: '1.0.0',
    relativePath: 'decomposition/critic-dedupe.v1.md',
  }),
  'decomposition.critic-source': Object.freeze({
    version: '1.0.0',
    relativePath: 'decomposition/critic-source.v1.md',
  }),
});

const CACHE = new Map();
const PROMPT_ROOT = path.join(__dirname, '..', '..', 'prompts');
const INCLUDE_PATTERN = /\{\{include:([^}]+)\}\}/g;

function promptError(message) {
  return Object.assign(new Error(message), { code: 'PROMPT_INVALID' });
}

function readPrompt(relativePath, stack = []) {
  const filename = path.resolve(PROMPT_ROOT, relativePath);
  const relative = path.relative(PROMPT_ROOT, filename);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw promptError('prompt include escapes prompt root');
  }
  if (stack.includes(filename)) throw promptError('prompt include cycle');
  const source = readFileSync(filename, 'utf8').trim();
  if (!source) throw promptError('versioned prompt is empty');
  return source.replace(INCLUDE_PATTERN, (_, includedPath) => (
    readPrompt(includedPath.trim(), [...stack, filename])
  ));
}

function loadVersionedPrompt(promptId) {
  if (CACHE.has(promptId)) return CACHE.get(promptId);
  const definition = DEFINITIONS[promptId];
  if (!definition) throw promptError('unknown versioned prompt');
  const text = readPrompt(definition.relativePath);
  const value = Object.freeze({
    id: promptId,
    version: definition.version,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
  });
  CACHE.set(promptId, value);
  return value;
}

module.exports = { loadVersionedPrompt };
