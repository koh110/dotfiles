code --list-extensions > "code/extensions.txt"
cp $HOME/Library/Application\ Support/Code/User/settings.json code
cp $HOME/Library/Application\ Support/Code/User/keybindings.json code
cp -R $HOME/Library/Application\ Support/Code/User/snippets code

cp ~/.vimrc ./
cp -r ~/.vim/* ./.vim/

cp $HOME/.tmux.conf .
