---
name: google-spreadsheet
description: 'Skills for gettting/fetching Google Spreadsheets data.'
---

# Google Spreadsheets のデータを取得

以下のCLIを利用してGoogle Spreadsheetsのデータをjson形式で取得する。

```bash
$ node ~/dev/spreadsheet-cli/src/index.ts read --spreadsheet-id {{id}} --range 'シート1!A1:I50' --json
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
