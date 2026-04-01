---
name: google-spreadsheet
description: 'Use when fetching data from Google Spreadsheets or writing to Google Spreadsheets via the spreadsheet-cli tool.'
---

# Google Spreadsheets のデータの取得/書き込み

以下のCLIを利用してGoogle Spreadsheetsのデータをjson形式で取得する。

```bash
# read
$ node ~/dev/spreadsheet-cli/src/index.ts read --spreadsheet-id {{id}} --range 'シート1!A1:I50' --format=json
# write
$ node ~/dev/spreadsheet-cli/src/index.ts write --spreadsheet-id {{id}} --range 'シート1!A1:I50'
```

[CLI documents](https://github.com/koh110/spreadsheet-cli/blob/main/README.md)

## init

profileがsetupされていない場合はローカルでsetupしてから利用を始める

```bash
$ cd ~/dev/spreadsheet-cli
$ npm install
# profile add
$ xxx
```
