const { readFile } = require('node:fs/promises');
const path = require('node:path');

const PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', 'system.md');
let SOURCE = null;

async function loadSystemPrompt() {
  if (SOURCE === null) {
    SOURCE = (await readFile(PROMPT_PATH, 'utf8')).trim();
  }
  return SOURCE;
}

const STEP_HEADINGS = Object.freeze({
  'check-goals': '## 步骤 1 ·',
  'extract-tasks': '## 步骤 2 ·',
  'classify-matrix': '## 步骤 4 ·',
  'generate-report': '## 步骤 5 ·',
});

function promptError(message) {
  return Object.assign(new Error(message), { code: 'PROMPT_INVALID' });
}

function parseStep(stepName, source) {
  const heading = STEP_HEADINGS[stepName];
  if (!heading) throw promptError('unknown prompt step');

  const start = source.indexOf(heading);
  if (start < 0) throw promptError('prompt step is missing');
  const remaining = source.slice(start + heading.length);
  const nextHeading = remaining.search(/^## /m);
  const section = nextHeading < 0 ? remaining : remaining.slice(0, nextHeading);
  const blocks = [...section.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g)];
  if (blocks.length !== 1) throw promptError('prompt step must contain one code block');

  const prompt = blocks[0][1].trim();
  if (!prompt) throw promptError('prompt step is empty');
  return prompt;
}

async function loadStepPrompt(stepName) {
  return parseStep(stepName, await loadSystemPrompt());
}

module.exports = { loadStepPrompt };
