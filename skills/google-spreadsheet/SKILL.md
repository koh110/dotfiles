---
name: google-spreadsheet
description: 'Use when fetching data from Google Spreadsheets via the spreadsheet-cli tool. Read-only: the CLI has no write command. For write requests, report the limitation and propose an alternative.'
---

# Google Spreadsheets のデータ取得

ローカルの spreadsheet-cli (`~/dev/spreadsheet-cli`) を利用して Google Spreadsheets のデータを取得する。

## 手順

1. spreadsheet URL から spreadsheet ID を抽出する
   - `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit#gid=0` の `<SPREADSHEET_ID>` 部分
2. read コマンドで取得する。機械処理する場合は `--format json` を指定する

```bash
node ~/dev/spreadsheet-cli/src/index.ts read \
  --spreadsheet-id <SPREADSHEET_ID> \
  --range 'シート1!A1:I50' \
  --format json
```

- `--range` は `シート名!A1:I50` 形式。シート名のみを指定するとそのシート全域を取得する
- `--format` は `json` / `csv` / `table`（default: `table`）
- profile は優先度順に自動フォールバックするため通常は指定不要。特定の profile を使う場合のみ `--profile <name>` を付ける

## 初回セットアップ（profile が無い / 認証エラーの場合）

`profile:add` は対話式プロンプトのためエージェントからは実行できない。ユーザーに以下の実行を依頼する:

```bash
cd ~/dev/spreadsheet-cli
npm install                    # 初回のみ
node src/index.ts profile:add  # 対話式で profile を作成
node src/index.ts profile:list # 登録済み profile の確認
```

## できないこと・エラー時の扱い

- **書き込みはできない**。CLI に write コマンドは存在しない。書き込み依頼を受けた場合は実装せず、その旨を報告した上で「CSV を生成してユーザーに貼り付けてもらう」等の代替案を提示する
- 全 profile で認証・quota エラーになった場合は、エラーメッセージをそのまま報告し、`node src/index.ts profile:list` の結果を添えてユーザーに判断を仰ぐ
- 空の結果が返った場合は range のシート名・範囲指定の誤りを先に疑い、シート名のみの range で再取得して確認する

ref: [CLI documents](https://github.com/koh110/spreadsheet-cli/blob/main/README.md)
