# Transactional outbox test用の認証付きMongoDB replica set

applicationがlocal ComposeまたはGitHub ActionsでMongoDB transactionを必要とするときに使います。

## 重要要件

authorizationを有効にしたMongoDB replica setでは、internal authentication用のkeyfileが必要です。`MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD` と `mongod --replSet ...` を組み合わせながら `--keyFile` を指定しないtopologyは、起動時に次のerrorで失敗します。

```text
BadValue: security.keyFile is required when authorization is enabled with replica sets
```

## Compose pattern

1. `umask 077` でrandom keyfileをnamed volumeへ書き込むone-shot keyfile-init serviceを作る。ownerはMongoDB user、modeは `0400` にする。
2. MongoDB serviceはkeyfile initializationの成功にdependさせる。
3. volumeをread-only mountし、MongoDBを `--replSet rs0 --bind_ip_all --keyFile /run/mongo-keyfile/keyfile` で起動する。
4. boundedなreadiness loopとprimary-election loopを持つ2つ目のone-shot init serviceを使う。member hostnameにはhost側のmapped portではなくCompose serviceのDNS名を設定する。
5. `replicaSet=rs0` を含むURIから `db.hello().isWritablePrimary === true` を確認する。

retry loopには必ず上限を設け、deadlineを超えたら明示的にfailしてください。CIやlocal verificationで無限の `until ...; do sleep 1; done` loopを使わないでください。

## CI pattern

ephemeral Docker volumeを作り、短命なMongo imageでkeyfileを生成してから、MongoDB test containerへread-only mountします。通常のMongoDB portをpublishし、single-member replica-set configurationでは `localhost:27017` を使います。削除済みの `job.services` port expressionを残さず、`TEST_MONGODB_PORT=27017` を明示的に渡します。

## 検証順序

1. `docker compose config --quiet`
2. MongoDBとinit serviceを起動する。
3. init serviceがexit code `0` で終了したことを確認する。
4. authenticated replica-set URIを使って `db.hello().isWritablePrimary` を確認する。
5. backend/auth integration testを実行する。
6. 検証後にCompose serviceを停止する。

TypeScript buildやWorker dry-runが成功しても、このtopologyを検証したことにはなりません。実際のtransaction testが必要です。
