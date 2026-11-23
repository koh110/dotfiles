# . "$HOME/.cargo/env"
export PATH=$PATH:/usr/local/go/bin
export PATH="$HOME/.local/bin:$PATH"

if [[ -f ~/.zshenv.local ]]; then
  source ~/.zshenv.local
fi

