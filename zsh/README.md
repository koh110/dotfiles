# zsh layered config

zsh の設定は Nix DSL や TypeScript に書き換えず、通常の `.zsh` ファイルを正本として保持します。

```text
zsh/
├── rc/
│   ├── common.zsh
│   ├── linux.zsh
│   ├── macos.zsh
│   └── wsl.zsh
└── env/
    ├── common.zsh
    ├── macos.zsh
    └── wsl.zsh

hosts/<host>/zsh/
├── rc.zsh
└── env.zsh
```

`.zshrc` と `.zshenv` はどちらも次の順序で生成します。

```text
common -> OS -> WSL -> host
```

WSL では OS layer として `linux` を適用した後に `wsl` を重ねます。

## deploy.ts

```sh
node deploy.ts --zsh
```

`deploy.ts` は fragment を連結して `~/.zshrc` / `~/.zshenv` を直接生成します。生成後のファイルから別の設定 fragment を `source` する構成にはしません。

host は hostname をデフォルトにし、必要なら `DOTFILES_HOST` で上書きできます。

```sh
DOTFILES_HOST=llm-server node deploy.ts --zsh
```

## Home Manager

`nix/zsh.nix` を import します。

```nix
{
  imports = [ ./nix/zsh.nix ];

  portableZsh = {
    enable = true;
    host = "llm-server";
  };
}
```

WSL は Nix 評価時には自動判定できないため明示します。

```nix
portableZsh.platform = "wsl";
```

Home Manager 側も `builtins.readFile` と `home.file.<name>.text` で同じ fragment を同じ順序に連結します。

Nix を外す場合も、raw `.zsh` fragment を `deploy.ts` や単純な `cat` で連結すればよく、設定内容の変換は不要です。

`backup.ts --zsh` は生成済みファイルを正本へ逆流させないため何も保存しません。zsh設定はこのディレクトリ内のfragmentを直接編集します。
