/**
 * SEMANTICS CHANGE: usernames switch from case-insensitive to case-preserving.
 *
 * Before this migration, usernames were stored in their original case but
 * normalized_username was lowercased (inferred), so uniqueness and login
 * matching were case-insensitive. This migration copies username into
 * normalized_username, preserving case, which changes how uniqueness and
 * login are evaluated.
 *
 * Migration impact:
 * - Before: Admin = admin (same user, first one registered wins)
 * - After:  Admin != admin (different users, case-sensitive uniqueness)
 * - Login:  still compares against normalized_username (unique index),
 *           so login IS case-sensitive after this migration
 * - Rollback: none. This is a one-way migration; dropping and re-applying
 *   only re-runs up() on an already-converted table.
 *
 * To restore case-insensitive behavior after this migration, login/lookup
 * must be changed to compare case-insensitively (e.g. LOWER(normalized_username)).
 */
const migration = Object.freeze({
  version: 2,
  name: 'preserve username case for authentication',
  async up(transaction) {
    await transaction.run('UPDATE users SET normalized_username = username');
  },
});

module.exports = migration;
