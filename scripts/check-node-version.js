const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const packageJson = require('../package.json');

function readVersionFile(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8').trim().replace(/^v/, '');
}

function nodeVersionError(message) {
  return Object.assign(new Error(message), { code: 'NODE_VERSION_MISMATCH' });
}

function assertNodeVersionContract(runtimeVersion = process.versions.node) {
  const expected = readVersionFile('.nvmrc');
  const declarations = {
    '.nvmrc': expected,
    '.node-version': readVersionFile('.node-version'),
    'package.json engines.node': String(packageJson.engines?.node || '').trim().replace(/^v/, ''),
    'package.json volta.node': String(packageJson.volta?.node || '').trim().replace(/^v/, ''),
  };

  for (const [source, version] of Object.entries(declarations)) {
    if (version !== expected) {
      throw nodeVersionError(
        `Node version declarations disagree: ${source}=${version || '<missing>'}, expected=${expected}.`,
      );
    }
  }

  const actual = String(runtimeVersion || '').trim().replace(/^v/, '');
  if (actual !== expected) {
    throw nodeVersionError(
      `This project requires Node.js ${expected}, but the active runtime is ${actual || '<unknown>'}. `
      + `Run "nvm install ${expected}" and "nvm use ${expected}", or install Volta and reopen the shell.`,
    );
  }

  return Object.freeze({ expected, actual });
}

function main() {
  try {
    const result = assertNodeVersionContract();
    process.stdout.write(`Node.js ${result.actual} matches the project runtime contract.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  assertNodeVersionContract,
};
