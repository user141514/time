# Migrations

Apply in version order. Migration files are immutable once applied.

## Migration impact notes

### 002 — preserve username case for authentication

Semantics change: usernames switch from case-insensitive to case-preserving.

- Before: Admin = admin (same user, first one registered wins)
- After: Admin != admin (different users, case-sensitive uniqueness)
- Login: case-sensitive via normalized_username unique index
- No rollback.

Before this migration normalized_username was lowercased (inferred); after it,
normalized_username = username. To restore case-insensitive login, compare
case-insensitively (e.g. LOWER(normalized_username)) in the login/lookup path.
