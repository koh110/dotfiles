#!/bin/bash
set -exuo pipefail

code --list-extensions > "code/extensions.txt"
cp ~/.config/Code/User/settings.json code
cp ~/.config/Code/User/keybindings.json code
cp -R ~/.config/Code/User/snippets code

cp ~/.vimrc ./
cp -r ~/.vim/* ./.vim/

cp ~/.tmux.conf .
