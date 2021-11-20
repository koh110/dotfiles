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


" dein
" reset augroup
augroup MyAutoCmd
  autocmd!
augroup END

" dein settings {{{
" dein自体の自動インストール
let s:cache_home = empty($XDG_CACHE_HOME) ? expand('~/.vim/.cache') : $XDG_CACHE_HOME
let s:dein_dir = s:cache_home . '/dein'
let s:dein_repo_dir = s:dein_dir . '/repos/github.com/Shougo/dein.vim'
if !isdirectory(s:dein_repo_dir)
  call system('git clone https://github.com/Shougo/dein.vim ' . shellescape(s:dein_repo_dir))
endif
let &runtimepath = s:dein_repo_dir .",". &runtimepath
" プラグイン読み込み＆キャッシュ作成
let s:toml_file = '~/.vim/dein.toml'
if dein#load_state(s:dein_dir)
  call dein#begin(s:dein_dir, [$MYVIMRC, s:toml_file])
  call dein#load_toml(s:toml_file)
  call dein#end()
  call dein#save_state()
endif
" 不足プラグインの自動インストール
if has('vim_starting') && dein#check_install()
  call dein#install()
endif

" color
syntax enable
set background=dark
colorscheme solarized
" colorscheme molokai
highlight Normal ctermbg=none

filetype plugin indent on

let g:syntastic_javascript_checkers=['eslint']
" エラー行に sign を表示
let g:syntastic_enable_signs = 1
" location list を常に更新
let g:syntastic_always_populate_loc_list = 0
" location list を常に表示
let g:syntastic_auto_loc_list = 0
" ファイルを開いた時にチェックを実行する
let g:syntastic_check_on_open = 1
" :wq で終了する時もチェックする
let g:syntastic_check_on_wq = 0
