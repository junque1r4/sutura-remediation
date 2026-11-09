# Database password rotation

## Existing volumes

Postgres only reads `POSTGRES_PASSWORD` **once**, at `initdb` — that is, the very
first time the container starts against an _empty_ `postgres-data` volume. The
password is then baked into the data directory. Changing `POSTGRES_PASSWORD` in
`.env` afterwards does **not** re-apply it: the new value goes into
`DATABASE_URL`, but the database still expects the old one, so every connection
fails at runtime with:

```
FATAL: password authentication failed for user "sutura" (SQLSTATE 28P01)
```

You have two ways forward.

**Option A — change the password inside the running database (keeps your data).**
This is the safe default when you only want to rotate the credential:

```bash
# 1. While the old password still works, rotate the role in-place.
docker compose exec postgres \
  psql -U sutura -d sutura -c "ALTER USER sutura WITH PASSWORD 'NEW_PASSWORD';"

# 2. Put the SAME NEW_PASSWORD into .env (POSTGRES_PASSWORD and the password
#    segment of DATABASE_URL), then recreate the app containers (NOT the volume).
docker compose up -d --force-recreate dashboard backend
```

**Option B — reset the volume (DESTROYS all data).** Only do this if you accept
losing the database contents. **Back up the volume FIRST** — `docker compose
down -v` is irreversible:

```bash
# 1. BACK UP the existing volume to a tarball before touching anything.
#    (Volume name is "<project>_postgres-data"; check with: docker volume ls)
docker run --rm \
  -v sutura_postgres-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/postgres-data-backup.tar.gz -C /data .

# 2. Tear down. The -v flag DELETES the postgres-data and redis-data volumes
#    PERMANENTLY — there is no undo. Make sure step 1 succeeded first.
docker compose down -v

# 3. Set the new POSTGRES_PASSWORD in .env, then cold-start. initdb runs
#    against the now-empty volume and applies the new password.
docker compose up --build
```

To restore the backup tarball into a fresh (but pre-initdb) volume, untar it
back the same way: `docker run --rm -v sutura_postgres-data:/data -v
"$PWD":/backup alpine sh -c "tar xzf /backup/postgres-data-backup.tar.gz -C
/data"`.
