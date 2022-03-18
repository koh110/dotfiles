#!/bin/bash
set -exuo pipefail


cp code/settings.json $HOME/Library/Application\ Support/Code/User/settings.json
cp code/keybindings.json $HOME/Library/Application\ Support/Code/User/keybindings.json
cp -R code/snippets/* $HOME/Library/Application\ Support/Code/User/snippets

# cat code/extensions.txt | xargs -n 1 code --install-extension
