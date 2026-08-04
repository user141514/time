function inputError() {
  return Object.assign(
    new Error('用户名不能为空且只能包含中文、字母、数字和下划线。'),
    { code: 'INPUT_INVALID' },
  );
}

// Case-sensitive exact-match normalization with Unicode NFC canonicalization.
// NFC folds compatibility-zone CJK characters (e.g. U+FA0A → U+898B) to prevent
// duplicate registrations via visually-identical but byte-distinct usernames.
function normalizeUsername(value) {
  if (typeof value !== 'string') throw inputError();
  const display = value.trim().normalize('NFC');
  if (!/^[\p{Script=Han}A-Za-z0-9_]+$/u.test(display)) throw inputError();
  return display;
}

// Backwards-compatible alias for callers that expect the old name.
const validateUsername = normalizeUsername;

module.exports = { normalizeUsername, validateUsername };
