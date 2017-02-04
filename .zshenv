# nvm
NVM_DIR="$HOME/.nvm"
# [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
# nvmのlazy load
# http://qiita.com/uasi/items/80865646607b966aedc8
# あらかじめ `nvm default vX.Y.Z` してエイリアス "default" を作っておく
PATH=${NVM_DIR:-$HOME/.nvm}/default/bin:$PATH
MANPATH=${NVM_DIR:-$HOME/.nvm}/default/share/man:$MANPATH
export NODE_PATH=${NVM_DIR:-$HOME/.nvm}/default/lib/node_modules

PATH=/bin:/usr/bin:/usr/local/bin:${PATH}TH=/bin:/usr/bin:/usr/local/bin:${PATH}

