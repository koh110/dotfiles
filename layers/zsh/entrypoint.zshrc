# Generated target entrypoint for deploy.ts --zsh.
# The source files themselves remain ordinary zsh files in the dotfiles repository.
for dotfiles_zsh_layer in \
  "$HOME/.config/dotfiles/zsh/10-common.zsh" \
  "$HOME/.config/dotfiles/zsh/20-os.zsh" \
  "$HOME/.config/dotfiles/zsh/30-wsl.zsh" \
  "$HOME/.config/dotfiles/zsh/40-host.zsh"
do
  [[ -r "$dotfiles_zsh_layer" ]] && source "$dotfiles_zsh_layer"
done
unset dotfiles_zsh_layer
