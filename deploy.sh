#!/bin/bash

mkdir -p ~/.ssh
if [ ! -e ~/.ssh/config ]; then
  cp .ssh/config ~/.ssh/config
fi

cp .gitconfig ~/
cp .tmux.conf ~/
cp .zshrc ~/
cp .zshenv ~/

cp -r .atom ~/
apm install --packages-file atomfile

cp .vim ~/
cp .vimrc ~/
