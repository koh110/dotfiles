# Decision endpoint adapter pattern

When a Worker exposes a human-gated decision endpoint, do not infer the wire shape from the prose `action=skip` requirement. First submit a harmless schema probe (still using the prepared run/hash) and use validation errors to distinguish:

- one decision per field vs. one decision per entity;
- scalar field lists vs. a `fields` record;
- recommendation state vs. field action state.

A known-good shape for an entity-level endpoint is:

```json
{
  "proposalHash": "<run hash>",
  "decisions": [
    {
      "code": "<entity code>",
      "recommendation": "rejected",
      "fields": {
        "<updatable field>": {
          "action": "skip",
          "reason": "検証のため更新なし"
        }
      }
    }
  ]
}
```

The recommendation enum and field record are API-specific; verify them from the live validator or project contract. The important invariant is that every entity's `updatableFields` is represented, every field action is explicitly `skip`, and no proposed value key is sent.

For scheduled jobs whose final response targets the same chat thread, a runtime or chat adapter may suppress a duplicate-target post. If an additional exact candidate message must be posted before the final report, use the adapter's documented separate-send mechanism, then verify the returned message ID. Do not alter the candidate body.
