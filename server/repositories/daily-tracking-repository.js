const crypto = require('node:crypto');

const { decodeStoredDaily, validateDailyRead, validateDailyWrite } = require('../daily-tracking/contracts');
const { UUID_PATTERN } = require('../history/contracts');

const UUID = new RegExp(UUID_PATTERN);
const COLUMNS = `
  id, tracking_date, tasks_json, tracking_json, removed_task_ids_json,
  revision, created_at, updated_at
`;

function authRequired() {
  return Object.assign(new Error('Authenticated userId is required.'), {
    code: 'AUTH_REQUIRED',
    status: 401,
    expose: true,
  });
}

function requireUserId(userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw authRequired();
  return userId;
}

function conflictError() {
  return Object.assign(new Error('每日清单已在其他页面更新，请重新加载。'), {
    code: 'DAILY_TRACKING_CONFLICT',
    status: 409,
    expose: true,
  });
}

function createDailyTrackingRepository({
  database,
  now = () => new Date().toISOString(),
  randomUUID = crypto.randomUUID,
}) {
  return Object.freeze({
    async get({ userId, trackingDate } = {}) {
      const ownerId = requireUserId(userId);
      const probe = validateDailyRead({
        trackingDate,
        tasks: [],
        tracking: {},
        removedTaskIds: [],
        revision: 0,
      });
      const row = await database.get(
        `SELECT ${COLUMNS}
         FROM daily_tracking_days
         WHERE user_id = ? AND tracking_date = ?`,
        [ownerId, probe.trackingDate],
      );
      return row ? decodeStoredDaily(row) : null;
    },

    async getLatestBefore({ userId, trackingDate } = {}) {
      const ownerId = requireUserId(userId);
      const probe = validateDailyRead({
        trackingDate,
        tasks: [],
        tracking: {},
        removedTaskIds: [],
        revision: 0,
      });
      const row = await database.get(
        `SELECT ${COLUMNS}
         FROM daily_tracking_days
         WHERE user_id = ? AND tracking_date < ?
         ORDER BY tracking_date DESC
         LIMIT 1`,
        [ownerId, probe.trackingDate],
      );
      return row ? decodeStoredDaily(row) : null;
    },

    async save({ userId, ...snapshot } = {}) {
      const ownerId = requireUserId(userId);
      const value = validateDailyWrite(snapshot);
      const timestamp = now();
      return database.transaction(async (transaction) => {
        let result;
        if (value.revision === 0) {
          const id = randomUUID();
          if (!UUID.test(id)) throw new Error('Daily tracking UUID source returned an invalid result.');
          // ponytail: DO NOTHING on first-create conflict — two tabs creating the same
          // day's tracking both succeed but one sees zero changes. The conflictError below
          // treats this as a generic conflict; the frontend retry will re-read the saved copy.
          result = await transaction.run(
            `INSERT INTO daily_tracking_days (
              id, user_id, tracking_date, tasks_json, tracking_json,
              removed_task_ids_json, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(user_id, tracking_date) DO NOTHING`,
            [
              id,
              ownerId,
              value.trackingDate,
              JSON.stringify(value.tasks),
              JSON.stringify(value.tracking),
              JSON.stringify(value.removedTaskIds),
              timestamp,
              timestamp,
            ],
          );
        } else {
          result = await transaction.run(
            `UPDATE daily_tracking_days
             SET tasks_json = ?,
                 tracking_json = ?,
                 removed_task_ids_json = ?,
                 revision = revision + 1,
                 updated_at = ?
             WHERE user_id = ? AND tracking_date = ? AND revision = ?`,
            [
              JSON.stringify(value.tasks),
              JSON.stringify(value.tracking),
              JSON.stringify(value.removedTaskIds),
              timestamp,
              ownerId,
              value.trackingDate,
              value.revision,
            ],
          );
        }
        if (result.changes !== 1) throw conflictError();
        const row = await transaction.get(
          `SELECT ${COLUMNS}
           FROM daily_tracking_days
           WHERE user_id = ? AND tracking_date = ?`,
          [ownerId, value.trackingDate],
        );
        return decodeStoredDaily(row);
      });
    },
  });
}

module.exports = { createDailyTrackingRepository };
