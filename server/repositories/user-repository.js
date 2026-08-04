const { normalizeUsername, validateUsername } = require('../auth/username');

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    normalizedUsername: row.normalized_username,
    passwordHash: row.password_hash,
    recoveryCodeHash: row.recovery_code_hash,
    recoveryCodeVersion: row.recovery_code_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function usernameTakenError() {
  return Object.assign(new Error('该用户名已被使用。'), {
    code: 'AUTH_USERNAME_TAKEN',
  });
}

function createUserRepository({ database, now = () => new Date().toISOString() }) {
  return Object.freeze({
    async createUser(transaction, user) {
      const username = validateUsername(user.username);
      const normalizedUsername = normalizeUsername(username);
      const timestamp = now();
      try {
        await transaction.run(
          `INSERT INTO users (
            id, username, normalized_username, password_hash, recovery_code_hash,
            recovery_code_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            user.id,
            username,
            normalizedUsername,
            user.passwordHash,
            user.recoveryCodeHash,
            user.recoveryCodeVersion ?? 1,
            timestamp,
            timestamp,
          ],
        );
      } catch (error) {
        if (
          error?.code === 'SQLITE_CONSTRAINT'
          && /users\.normalized_username|users_normalized_username_unique/.test(error.message)
        ) {
          throw usernameTakenError();
        }
        throw error;
      }
      return mapUser(await transaction.get(
        `SELECT id, username, normalized_username, password_hash, recovery_code_hash,
                recovery_code_version, created_at, updated_at
         FROM users
         WHERE id = ?`,
        [user.id],
      ));
    },

    async findByNormalizedUsername(normalizedUsername, client = database) {
      const row = await client.get(
        `SELECT id, username, normalized_username, password_hash, recovery_code_hash,
                recovery_code_version, created_at, updated_at
         FROM users
         WHERE normalized_username = ?`,
        [normalizeUsername(normalizedUsername)],
      );
      return mapUser(row);
    },

    async findById(userId, client = database) {
      const row = await client.get(
        `SELECT id, username, normalized_username, password_hash, recovery_code_hash,
                recovery_code_version, created_at, updated_at
         FROM users
         WHERE id = ?`,
        [userId],
      );
      return mapUser(row);
    },

    async updateCredentials(transaction, { userId, passwordHash, recoveryCodeHash }) {
      return transaction.run(
        `UPDATE users
         SET password_hash = ?,
             recovery_code_hash = ?,
             recovery_code_version = recovery_code_version + 1,
             updated_at = ?
         WHERE id = ?`,
        [passwordHash, recoveryCodeHash, now(), userId],
      );
    },

    async rotateRecoveryCode(transaction, {
      userId,
      expectedPasswordHash,
      recoveryCodeHash,
    }) {
      return transaction.run(
        `UPDATE users
         SET recovery_code_hash = ?,
             recovery_code_version = recovery_code_version + 1,
             updated_at = ?
         WHERE id = ? AND password_hash = ?`,
        [recoveryCodeHash, now(), userId, expectedPasswordHash],
      );
    },
  });
}

module.exports = { createUserRepository };
