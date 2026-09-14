# Authenticated MongoDB replica set for transactional-outbox tests

Use this when the application requires MongoDB transactions in local Compose or GitHub Actions.

## Key requirement

MongoDB replica sets with authorization enabled require an internal-authentication keyfile. A topology that combines `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD` with `mongod --replSet ...` but omits `--keyFile` fails at startup with:

```text
BadValue: security.keyFile is required when authorization is enabled with replica sets
```

## Compose pattern

1. Create a one-shot keyfile-init service that writes a random keyfile to a named volume using `umask 077`, owned by the MongoDB user and mode `0400`.
2. Make the MongoDB service depend on successful keyfile initialization.
3. Mount the volume read-only and launch MongoDB with `--replSet rs0 --bind_ip_all --keyFile /run/mongo-keyfile/keyfile`.
4. Use a second one-shot init service with bounded readiness and primary-election loops; configure the member hostname to the Compose service DNS name, not the host-mapped port.
5. Test readiness with `db.hello().isWritablePrimary === true` through a URI containing `replicaSet=rs0`.

Use bounded retry loops and fail explicitly after the deadline. Do not use unbounded `until ...; do sleep 1; done` loops in CI or local verification.

## CI pattern

Create an ephemeral Docker volume, generate the keyfile in a short-lived Mongo image, then mount it read-only into the MongoDB test container. Publish the normal MongoDB port and use `localhost:27017` in the single-member replica-set configuration. Pass `TEST_MONGODB_PORT=27017` explicitly rather than retaining a removed `job.services` port expression.

## Verification order

1. `docker compose config --quiet`
2. Start MongoDB and its init service.
3. Assert init service exited `0`.
4. Run `db.hello().isWritablePrimary` using the authenticated replica-set URI.
5. Run backend/auth integration tests.
6. Stop Compose services after verification.

A successful TypeScript build or Worker dry-run does not verify this topology; real transaction tests are required.
