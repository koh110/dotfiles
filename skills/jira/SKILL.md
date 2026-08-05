---
name: jira
description: 'Use when fetching Jira Cloud issue details via the acli tool. Read-only: do not use write/transition/comment-post commands.'
---

# Jira Issue の詳細取得

Atlassian公式CLI `acli` を利用して Jira Cloud の issue 詳細を取得する。

## 使い方

**`--json` を付けずに使う(基本形)。** `description` を含む ADF(Atlassian Document Format)構造がプレーンテキストに自動展開され、かつ `avatarUrls` / `self` URL / `schema` 等の付随メタデータが乗らないため、`--json` 付きより大幅にコンパクトになる。

```bash
acli jira workitem view <ISSUE-KEY>
```

- デフォルトで取得されるフィールド: `key`, `issuetype`, `summary`, `status`, `assignee`, `description`
- ブラウザで開きたい場合は `--web`(通常は使わない)
- `--json` は機械的にパースする用途向けだが、`description` が ADF の生JSON(ネストした `paragraph`/`listItem`/`bulletList` 構造)のまま返り、かつ大量のnullフィールドが付随して出力が大きく膨らむため、通常は使わない。JSONでの構造的な取り扱いがどうしても必要な場合のみ使う

## コメントの取得

**コメントは必ず `--json` 経由で取得する。** `acli` の素の(非JSON)表示モードは `comment` フィールドを一切レンダリングしない(`--fields comment` を付けても何も出力されない)ため、素の表示だけで「コメント無し」と判断しない。

```bash
acli jira workitem view <ISSUE-KEY> --fields comment --json \
  | jq '[.fields.comment.comments[] | {author: .author.displayName, created, text: ([(.body | ..) | (.text? // empty), (if .type? == "inlineCard" then .attrs.url else empty end)] | map(select(. != "")) | join(" "))}]'
```

- `comment.body` は ADF なので、上記の jq でテキストノードとリンクカード(`inlineCard`)の URL を平坦なテキストに変換して抽出する(段落・リスト構造は失われる簡易変換だが、コンテキスト消費を抑えつつ内容は読み取れる)
- 出力結果が空配列 `[]` の場合のみ「コメント無し」と判断する

## 初回セットアップ(未認証の場合)

認証情報の入力を伴うため、エージェントからは実行できない。ユーザーに以下の実行を依頼する。

1. acli のインストール(未インストールの場合)

```bash
brew tap atlassian/homebrew-acli
brew install acli
```

2. 認証。いずれかの方式で行う

- OAuth(ブラウザ経由、推奨)

```bash
acli jira auth login --site "<company>.atlassian.net" --web
```

- API token(https://id.atlassian.com/manage-profile/security/api-tokens で発行。token は標準入力経由)

```bash
echo <token> | acli jira auth login --site "<company>.atlassian.net" --email "<email>" --token
```

3. 認証状態の確認

```bash
acli jira auth status
```

## できないこと・エラー時の扱い

- **書き込みはできない**。`create` / `edit` / `delete` / `transition` / `comment`(投稿) 等の書き込み系コマンドは使用しない。読み取り専用として運用する
- issue の検索(`jira workitem search`)は現時点でスコープ外。必要になった場合は実装せず、ユーザーに相談する
- 認証エラーになった場合は `acli jira auth status` の結果をそのまま報告し、再認証をユーザーに依頼する

ref: [Atlassian CLI 公式ドキュメント](https://developer.atlassian.com/cloud/acli/)
