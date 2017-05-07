# nvm
NVM_DIR="$HOME/.nvm"
# [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
# nvmのlazy load
# http://qiita.com/uasi/items/80865646607b966aedc8
# あらかじめ `nvm alias default vX.Y.Z` してエイリアス "default" を作っておく
NVM_PATH=${NVM_DIR:-$HOME/.nvm}
NODE_DEFAULT_VERSION=v$(cat ${NVM_PATH}/alias/default)
NODE_DEFAULT=${NVM_PATH}/versions/node/${NODE_DEFAULT_VERSION};
MANPATH=${NODE_DEFAULT}/share/man:$MANPATH
export NODE_PATH=${NODE_DEFAULT}/lib/node_modules

PATH=${NODE_DEFAULT}/bin:$PATH
