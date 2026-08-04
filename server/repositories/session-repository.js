const crypto = require('node:crypto');

const { hashToken } = require('../security/token-hash');

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    csrfTokenHash: row.csrf_token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
  };
}

function createSessionRepository({
  database,
  now = () => new Date().toISOString(),
  randomUUID = crypto.randomUUID,
}) {
  async function findByToken(rawSessionId, client = database) {
    const tokenHash = hashToken(rawSessionId);
    const row = await client.get(
      `SELECT id, user_id, token_hash, csrf_token_hash, created_at, expires_at, last_seen_at
       FROM sessions
       WHERE token_hash = ?`,
      [tokenHash],
    );
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.parse(now())) {
      // ponytail: expired-session cleanup piggybacks on read — avoids a separate
      // pruning job but means findByToken is not a pure read. If called inside a
      // transaction, this DELETE participates in it.
      await client.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
      return null;
    }
    return mapSession(row);
  }

  return Object.freeze({
    async upsert({ rawSessionId, userId, csrfTokenHash, sessionMaxAgeMs }) {
      const timestamp = now();
      const expiresAt = new Date(Date.parse(timestamp) + sessionMaxAgeMs).toISOString();
      const tokenHash = hashToken(rawSessionId);
      await database.run(
        `INSERT INTO sessions (
          id, user_id, token_hash, csrf_token_hash, created_at, expires_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET
          user_id = excluded.user_id,
          csrf_token_hash = excluded.csrf_token_hash,
          expires_at = excluded.expires_at,
          last_seen_at = excluded.last_seen_at`,
        [randomUUID(), userId, tokenHash, csrfTokenHash, timestamp, expiresAt, timestamp],
      );
      return findByToken(rawSessionId);
    },

    findByToken,

    setCsrfHash(rawSessionId, csrfTokenHash, client = database) {
      return client.run(
        'UPDATE sessions SET csrf_token_hash = ? WHERE token_hash = ?',
        [csrfTokenHash, hashToken(rawSessionId)],
      );
    },

    // ponytail: touch only bumps last_seen_at; rolling:false means expiry is absolute.
    // If rolling sessions are enabled, pass sessionMaxAgeMs and extend expires_at.
    touch(rawSessionId) {
      const timestamp = now();
      return database.run(
        `UPDATE sessions
         SET last_seen_at = ?
         WHERE token_hash = ? AND expires_at > ?`,
        [timestamp, hashToken(rawSessionId), timestamp],
      );
    },

    destroyCurrent(rawSessionId, client = database) {
      return client.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(rawSessionId)]);
    },

    destroyAllForUser(transaction, userId) {
      return transaction.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    },

    pruneExpired(client = database) {
      return client.run('DELETE FROM sessions WHERE expires_at <= ?', [now()]);
    },
  });
}

module.exports = { createSessionRepository };
