# Materialized read-model publication

Use this pattern when asynchronous work turns a mutable source-of-truth record into immutable JSON/HTML artifacts behind a stable read URL.

## Separate the stages

A publisher CLI can be implemented and verified before selecting an outbox relay or scheduler, but this is only a publication primitive—not an end-to-end eventual-delivery guarantee.

Keep these contracts distinct:

1. source mutation → durable event/outbox
2. event claim/order/retry → publisher invocation
3. source snapshot → validated artifact
4. immutable artifact write → stable manifest switch
5. stable manifest → read-path rendering/cache

Mark unimplemented stages explicitly. Do not claim “post保存ごとに反映” when only stages 3–5 exist.

## Immutable revision + manifest switch

Recommended key shape:

```text
records/{id}/revisions/sha256-{contentHash}/page.json
records/{id}/manifest.json
```

Publication order:

1. Validate and canonically serialize the page JSON.
2. Hash the exact bytes that will be stored.
3. Create the revision object with `If-None-Match: *`; if it already exists, verify stored hash metadata instead of overwriting.
4. Read the current manifest and ETag.
5. Reject source-version regression.
6. Update the manifest with `If-Match: <etag>` or, if absent, `If-None-Match: *`.
7. On precondition failure, re-read and re-evaluate; do not blindly retry the same write.

The manifest must be the last visibility switch. A revision upload failure must leave the previous manifest unchanged.

## Source ordering is a first-class field

Include a source-derived ordering value such as `sourceModifiedAt`, source revision, or outbox sequence. Generation time alone is not adequate ordering: retries and concurrent workers can finish out of order.

A timestamp is sufficient only when the source contract guarantees monotonic updates at the needed resolution. Otherwise use a database revision/sequence. Equal ordering values with different content are a conflict and should fail closed.

## Unpublish/delete

Refusing to publish a draft does not revoke a previously published artifact. Define an explicit tombstone manifest:

```json
{
  "schemaVersion": 1,
  "recordId": 123,
  "state": "unpublished",
  "sourceVersion": "...",
  "generatedAt": "..."
}
```

Readers return a deterministic 404/410 according to product semantics and never fall back to the old revision. Old immutable objects may remain until a separately designed lifecycle policy removes them.

Physical deletion is harder because the source row may no longer provide an ordering value. The outbox/event must carry the record ID and source sequence before deletion, or the deletion workflow must write a durable tombstone in the source transaction. Do not invent deletion ordering in the publisher from wall-clock time.

## DB-less reconciliation as an explicit weaker contract

Sometimes the product owner intentionally rejects source-side dirty/outbox state to keep a legacy database unchanged. This can be valid only when the weaker guarantee is explicit: immediate publication is best-effort, and convergence occurs after an operator or scheduler completes a full reconciliation. Do not describe this as durable event delivery.

Use a fail-closed reconciliation workflow:

1. Capture a complete, lightweight source inventory containing every managed ID and publication state. Record start/end time, count, and a hash; a partial scan is unusable for deletion decisions.
2. Completely paginate the remote manifest inventory and validate every deletion candidate's actual manifest, not only list metadata or a cache index.
3. Compute `source published - remote published` as publish-needed and `remote published - source managed/published` as tombstone candidates. Restrict both sides to an explicit owner/prefix/ID namespace.
4. Treat objects generated at or after source-snapshot start as concurrent and skip them. Prefer a safe false negative to tombstoning a newly published record.
5. Write an immutable dry-run plan with snapshot hashes, candidate ETags, an expiry, a candidate-count guard, and a canonical plan hash. Never apply deletions directly from streaming scan output.
6. On apply, recheck source existence/state and current manifest ETag immediately before each tombstone CAS. Any change becomes a skip/nonzero result and requires a fresh plan.
7. Publish a tombstone manifest; do not physically delete immutable revisions during reconciliation.

At scale, use keyset pagination, streaming NDJSON, bounded concurrency, atomic checkpoints, and resumable reports. A full republish must not skip solely on a record's modified timestamp when rendered output also depends on taxonomy, metadata, author records, templates, plugins, or filters. If an incomplete scan, duplicate ID, invalid manifest, cursor loop, count anomaly, expired plan, or excessive tombstone count is observed, make no destructive changes.

A reconciliation wall-clock may identify the observation run, but it is not proof of original deletion order. The apply-time source recheck plus manifest CAS is the safety boundary. If strict event ordering or bounded automatic recovery is required, this DB-less mode is insufficient; return to a durable source version/outbox design.

## Reader validation

Readers should validate:

- manifest and page size before loading bodies
- schema version and exact runtime schema
- request ID = manifest ID = page ID
- manifest artifact key equals the key recomputed from ID + revision
- hash of exact page bytes equals manifest hash
- canonical URL and other security-sensitive URLs against an allowlist

For `HEAD` or conditional `304`, perform the same manifest/revision selection and integrity checks as `GET`. Do not optimize `HEAD` to manifest-only validation: returning 200/304 from the manifest alone can hide a missing or corrupt revision that GET would fail to serve. If object metadata does not carry a trustworthy content hash, read and hash the exact revision bytes even for `HEAD`; response-body suppression happens only after validation.

## Strict source export and sanitization boundary

When the source is WordPress or another plugin-driven CMS:

- export through the application runtime so filters/shortcodes are applied, but keep the exporter read-only and stream it over stdin rather than placing probe files in the live tree
- prefix the machine-readable JSON line because bootstrap code may emit warnings or unrelated stdout
- validate the exporter payload again in the publisher: exact schema, requested ID, publication state, canonical URL, source ordering, and password/private exclusions
- sanitize `contentHtml` before artifact publication with tag/attribute/protocol allowlists plus URL-host/path policy for images and embeds; protocol filtering alone is insufficient
- test persisted output bytes, not only the sanitizer function: scan representative live fixtures for `script`, event attributes, `javascript:`, `srcdoc`, and CSS `url()` and verify content hash against the manifest

## Verification ladder

Do not stop at unit tests. Verify each boundary in increasing scope:

1. runtime schema/parser tests, renderer escaping tests, CAS/concurrency tests
2. typecheck and packaging/dry-run build
3. source-runtime syntax check and read-only export of a real public record
4. filesystem dry-run that writes revision then manifest and re-hashes stored bytes
5. isolated local object-store + Worker E2E for GET, HEAD, conditional 304, tombstone, missing revision, and hash mismatch

If the local runtime rejects a future compatibility date, first align the pinned CLI/runtime package with that date; do not weaken the production compatibility date merely to make an old local binary start. Treat this as a setup correction, then rerun the E2E.

## Failure policy

- Broken/invalid new manifest: deterministic 5xx; do not silently fall back to origin unless the product explicitly accepts origin-load amplification.
- Publication failure: keep the last successful manifest.
- Tombstone: cache only according to the republish latency contract.
- Error responses: do not expose storage keys, stack traces, credentials, or artifact body.

## Test matrix

- revision write failure leaves manifest untouched
- manifest CAS conflict with newer source rejects stale worker
- equal source version + different content fails closed
- retry of identical revision is idempotent
- tombstone supersedes published revision
- delayed publish cannot supersede newer tombstone
- missing revision behind valid manifest fails GET and HEAD consistently
- hash/key/ID mismatch is rejected
- no automatic origin fallback under artifact failure
