# zsh layered deploy sample

`node deploy.ts --zsh` の `.zshrc` 配置を、設定内容を生成せず raw zsh file のレイヤーとして扱うサンプルです。TypeScript の実行には Node.js 組み込みの strip-types を使い、`tsx` / `ts-node` は使いません。

適用順は次の通りです。

```text
10-common.zsh
  -> 20-os.zsh
  -> 30-wsl.zsh
  -> 40-host.zsh
```

`~/.zshrc` 自体は `entrypoint.zshrc` のコピーで、上記ファイルを順に `source` するだけです。

現段階では段階移行のため、

- common: repository root の `.zshrc`
- OS / WSL: 既存 `templates/files/<platform>/.zshrc`
- host: `hosts/<hostname>/.zshrc` または `DOTFILES_HOST` で指定した名前

を入力として使います。

つまり既存設定を一括移動せず、deploy方式だけ先に `common -> OS -> WSL -> host` にできます。次の段階で `templates/files` 側のzsh差分を `files/<platform>` に移せます。

`.zshenv` はまだ既存の `deployDotfile` の挙動を維持しています。このDraftでは `.zshrc` だけを移行サンプルにしています。
