---
name: development-backend
description: 'Use when writing or editing API handlers, database queries, or server-side logic. Enforces performance constraints, error response standards, and SQL best practices.'
---

- O(N) となる処理を避け、O(1) となるように処理を記述する
- ループ処理の内部でSQLのINSERT/UPDATE/DELETEを繰り返し実行することを禁じる

## Error Response Guidelines

- APIエラーの設計は下記RFCに従う
  - RFC 9457: Problem Details for HTTP APIs
  - RFC 9205: Building Protocols with HTTP

### ref
- https://www.rfc-editor.org/rfc/rfc9457
- https://www.rfc-editor.org/rfc/rfc9205
