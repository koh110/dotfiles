# zsh layered config

zsh の設定は Nix DSL や TypeScript に書き換えず、通常の `.zsh` ファイルを正本として保持します。

適用順は次の通りです。

```text
.zshrc                  # common
zsh/<os>.zsh            # linux | macos (optional)
zsh/wsl.zsh             # WSL only (optional)
hosts/<host>/zsh.zsh    # host-specific (optional)
```

`node deploy.ts --zsh` はこれらを順番に連結し、最終的な `~/.zshrc` を1ファイルとして書き出します。実行時に追加ファイルを `source` する構成にはしません。

host はデフォルトで hostname を使い、必要なら `DOTFILES_HOST` で上書きできます。

```sh
DOTFILES_HOST=llm-server node deploy.ts --zsh
```

Home Manager を使う場合は `nix/zsh.nix` を import します。

```nix
{
  imports = [ ./nix/zsh.nix ];

  portableZsh = {
    enable = true;
    host = "llm-server";
  };
}
```

WSL は Nix の評価時に自動判定しないため明示します。

```nix
portableZsh.platform = "wsl";
```

Home Manager 側も `builtins.readFile` と `home.file.".zshrc".text` を使って同じ順序で連結します。Nix を外す場合も、raw `.zsh` 断片を `deploy.ts` や単純な `cat` で連結すればよく、設定内容の変換は不要です。

現段階では既存 root `.zshrc` を common として残しています。今後必要ならその中に残る OS 分岐を `zsh/linux.zsh` / `zsh/macos.zsh` へ段階的に移します。
