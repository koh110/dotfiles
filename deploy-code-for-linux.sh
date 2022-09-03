#!/bin/bash
set -exuo pipefail


cp code/settings.json $HOME/.config/Code/User
cp code/keybindings.json $HOME/.config/Code/User
cp -R code/snippets $HOME/.config/Code/User/

# cat code/extensions.txt | xargs -n 1 code --install-extension
