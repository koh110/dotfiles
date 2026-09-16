# Portable dotfiles overlay prototype

Nix/Home Manager を source of truth にせず、raw な設定ファイルを `common -> OS -> host` の順に重ねるプロトタイプです。

既存の `deploy.ts` / `lib/dotfile-template.ts` は変更しません。このディレクトリだけで方式を評価できます。

## レイヤー

通常の Linux / macOS:

```text
files/common
  -> files/linux | files/darwin
  -> hosts/<host>
```

WSL:

```text
files/common
  -> files/linux
  -> files/wsl
  -> hosts/<host>
```

後のレイヤーがファイル単位で勝ちます。

## Shell backend

```sh
./bin/apply-dotfiles
```

host を明示する場合:

```sh
DOTFILES_HOST=llm-server ./bin/apply-dotfiles
```

実HOMEを触らず試す場合:

```sh
DOTFILES_HOME=/tmp/dotfiles-home DOTFILES_HOST=llm-server ./bin/apply-dotfiles
```

既存の通常ファイルは上書きしません。管理対象へ移行する場合は先に退避・削除する必要があります。

## Home Manager backend

`nix/module.nix` を import します。

```nix
portableDotfiles = {
  enable = true;
  root = /path/to/this/prototype;
  host = "llm-server";
};
```

WSL は Nix 評価時に自動判定しないため明示します。

```nix
portableDotfiles.platform = "wsl";
```

Home Manager は「どのraw fileを配置するか」だけを担当し、設定内容を Nix DSL へ変換しません。

## Nixを剥がす場合

`nix/` を捨てて `bin/apply-dotfiles` を使えばよく、アプリケーション設定を Nix expression から復元する作業は発生しません。

## 現行方式からの移行イメージ

現状の `templates/files/{linux,macos,wsl}` は設定へ行単位で差分を追加しています。移行する場合は一括変換せず、設定ごとに次の順で寄せます。

1. 共通設定を `files/common` へ置く
2. OS差分を `files/<platform>` へ分離する
3. マシン固有差分を `hosts/<host>` へ分離する
4. 設定自身に include 機能がある場合は、ファイル丸ごとの上書きより include を優先する
5. template はどうしてもraw fileで表現できない場合だけ残す

このプロトタイプでは shell 設定を include 型の例として使っています。
