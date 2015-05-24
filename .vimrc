"行番号表示
set number
"ファイル名表示
set title
"ルーラーの表示
set ruler
"モードの表示
set showmode
"対応する括弧の表示
set showmatch
"入力中のコマンドの表示
set showcmd
"ステータスラインを表示
set laststatus=2

" タブを表示するときの幅
set tabstop=4
" タブを挿入するときの幅
set shiftwidth=4
"タブや空白、改行の表示
set list
set listchars=tab:»-,trail:-,eol:↲,nbsp:%
" ファイルのディレクトリを自動的にカレントディレクトリに変更
au BufEnter * execute ":lcd " . expand("%:p:h")

" backupファイルを作らない
set nobackup

" インデント設定
set tabstop=2
set shiftwidth=2
set expandtab
