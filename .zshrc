# 補完
autoload -U compinit
# 1日1回だけ補完ファイルを再生成、それ以外はキャッシュを使用
if [[ -n ~/.zcompdump(#qN.mh+24) ]]; then
  compinit
else
  compinit -C
fi
## 小文字/大文字両方補完
#zstyle ':completion:*' matcher-list 'm:{a-z}={A-Z}'
## sudo の後ろでコマンド名を補完する
zstyle ':completion:*:sudo:*' command-path /usr/local/sbin /usr/local/bin \
                   /usr/sbin /usr/bin /sbin /bin /usr/X11R6/bin
## ps コマンドのプロセス名補完
zstyle ':completion:*:processes' command 'ps x -o pid,s,args'
##
bindkey '^P' history-beginning-search-backward
bindkey '^N' history-beginning-search-forward

# 色
autoload -Uz colors
colors

# ls
export LSCOLORS=gxfxcxdxbxegedabagacag
export LS_COLORS='di=36;40:ln=35;40:so=32;40:pi=33;40:ex=31;40:bd=34;46:cd=34;43:su=30;41:sg=30;46:tw=30;42:ow=30;46'

zstyle ':completion:*:default' list-colors ${(s.:.)LS_COLORS}
# lsがカラー表示になるようエイリアスを設定
case "${OSTYPE}" in
darwin*)
  # Mac
  alias ls="ls -GF"
  ;;
linux*)
  # Linux
  alias ls='ls -F --color'
  ;;
esac

# history
HISTFILE=~/.zsh_history
HISTSIZE=1000000
SAVEHIST=1000000

# prompt
autoload -Uz vcs_info
zstyle ':vcs_info:*' formats '%F{green}(%s)-[%b]%f'
zstyle ':vcs_info:*' actionformats '%F{green}(%s)-[%b|%a]%f'
autoload -Uz is-at-least
if is-at-least 4.3.10; then
  zstyle ':vcs_info:git:*' check-for-changes true
  zstyle ':vcs_info:git:*' stagedstr     '*'  # Changes to be committed
  zstyle ':vcs_info:git:*' unstagedstr   '*'  # Changes not staged for commit
  zstyle ':vcs_info:git:*' formats       '%F{green}(%s)-[%b]%f %F{magenta}%c%u%f'
  zstyle ':vcs_info:git:*' actionformats '%F{green}(%s)-[%b|%a]%f %F{magenta}%c%u%f'
fi
function tmux_context_theme_values() {
    local host="$1"
    local pane_bg="default"
    local active_bg="default"
    local status_bg="colour236"
    local status_left_fg="colour255"
    local current_window_bg="colour27"
    local current_window_fg="colour255"

    case "$host" in
        dev-server)
            pane_bg="colour18"
            active_bg="colour18"
            status_bg="colour25"
            current_window_bg="colour32"
            ;;
        guest)
            pane_bg="colour52"
            active_bg="colour52"
            status_bg="colour88"
            current_window_bg="colour124"
            ;;
    esac

    print -r -- "$pane_bg $active_bg $status_bg $status_left_fg $current_window_bg $current_window_fg"
}

function tmux_apply_context_theme() {
    [[ -z "$TMUX" ]] && return 0

    local host="${HOST%%.*}"
    local theme_key="$host"
    [[ "$TMUX_CONTEXT_THEME_KEY" == "$theme_key" ]] && return 0

    local values pane_bg active_bg status_bg status_left_fg current_window_bg current_window_fg
    values=(${(z)$(tmux_context_theme_values "$host")})
    pane_bg="$values[1]"
    active_bg="$values[2]"
    status_bg="$values[3]"
    status_left_fg="$values[4]"
    current_window_bg="$values[5]"
    current_window_fg="$values[6]"

    tmux set-window-option -g window-style "bg=${pane_bg},fg=default" >/dev/null 2>&1
    tmux set-window-option -g window-active-style "bg=${active_bg},fg=default" >/dev/null 2>&1
    tmux set-option -g status-style "bg=${status_bg},fg=${status_left_fg}" >/dev/null 2>&1
    tmux set-option -g status-left "#{?client_prefix,#[reverse],}#[fg=${status_left_fg},bg=${status_bg}] Session: #S #[default]" >/dev/null 2>&1
    tmux set-option -g status-right "#{?client_prefix,#[reverse],}#[fg=${status_left_fg},bg=${status_bg}] #H | %Y/%m/%d(%a) %H:%M:%S #[default]" >/dev/null 2>&1
    tmux set-window-option -g window-status-current-format "#[fg=${current_window_fg},bg=${current_window_bg},bold] #I: #W#{?window_zoomed_flag, [z],} #[default]" >/dev/null 2>&1

    export TMUX_CONTEXT_THEME_KEY="$theme_key"
}

precmd () {
    psvar=()
    LANG=en_US.UTF-8 vcs_info
    psvar[1]="$vcs_info_msg_0_"
    tmux_apply_context_theme
}
PROMPT=$'%{${fg_bold[red]}%}${USER}@${HOST}%{${reset_color}%} %{${fg[blue]}%}%~%{${reset_color}%} %1(v|$psvar[1]|)\n%(!.#.$) '

# alias
## 色一覧
alias zcolor='for c in {000..255}; do echo -n "\e[38;5;${c}m $c" ; [ $(($c%16)) -eq 15 ] && echo;done;echo'
alias zcolora='for c in {016..255}; do echo -n "\e[38;5;${c}m $c" ; [ $(($((c-16))%6)) -eq 5 ] && echo;done;echo'
alias json="node -e 'd=\"\";process.stdin.resume();process.stdin.on(\"data\",c => d+=c);process.stdin.on(\"end\", () => console.dir(JSON.parse(d), {colors:true,depth:5}))'"
alias ghpo="git push origin $(git branch --show-current) --force-with-lease"
alias ghprc="gh pr create --base main $(git branch --show-current)"

# zsh options
setopt auto_cd              # ディレクトリのみで移動
setopt extended_history     # 履歴に開始時刻と経過時間を記録
setopt long_list_jobs       # 内部コマンド jobs の出力をデフォルトで jobs -L にする
setopt auto_resume          # サスペンド中のプロセスと同じコマンド名を実行した場合はリジューム
setopt hist_ignore_all_dups # 重複するコマンド行は古い方を削除
setopt pushd_silent         # pushd, popdの度にディレクトリスタックの中身を表示しない
setopt auto_pushd           # 普通に cd するときにもディレクトリスタックにそのディレクトリを入れる
setopt extended_glob        # 拡張グロブを有効にする
setopt print_eight_bit      # 日本語のファイル名を表示可能
setopt prompt_subst         # プロンプトに escape sequence (環境変数) を通す
setopt pushd_ignore_dups    # ディレクトリスタックに重複する物は古い方を削除
setopt numeric_glob_sort    # 数字を数値と解釈してソートする
setopt list_types           # 補完候補一覧でファイルの種別を識別マーク表示
setopt auto_remove_slash    # 補完で末尾に補われた / を自動的に削除
setopt always_last_prompt   # カーソル位置は保持したままファイル名一覧を順次その場で表示
setopt hist_ignore_space    # スペースで始まるコマンド行はヒストリリストから削除
setopt no_beep              # コマンド入力エラーでBeepを鳴らさない
setopt share_history        # 履歴の共有
setopt hist_reduce_blanks   # 余分な空白は詰めて記録
setopt no_hup               # ログアウト時にバックグラウンドジョブをkillしない
setopt complete_in_word     # 単語の途中でもカーソル位置を元に補完可能
setopt braceccl             # 文字列のブレース展開 {A-Z}
setopt bang_hist            # !を使ったヒストリ展開を行う
setopt pushd_minus          # スタック上のディレクトリを特定するときの'-'と'+'の意味を逆にする
setopt rcquotes             # ダブルシングルクオートでシングルクオートをエスケープする
setopt prompt_subst         # プロンプトの変数展開を毎回行う
unsetopt cdable_vars        # $HOMEを先頭に'~'を付けたもので展開する
unsetopt auto_param_slash   # ディレクトリ名の補完で末尾の / を自動的に付加し、次の補完に備える

# tmux
function is_exists() { type "$1" >/dev/null 2>&1; return $?; }
function is_osx() { [[ $OSTYPE == darwin* ]]; }
function is_screen_running() { [ ! -z "$STY" ]; }
function is_tmux_runnning() { [ ! -z "$TMUX" ]; }
function is_screen_or_tmux_running() { is_screen_running || is_tmux_runnning; }
function shell_has_started_interactively() { [ ! -z "$PS1" ]; }
function is_ssh_running() { [ ! -z "$SSH_CONNECTION" ]; }

function tmux_automatically_attach_session()
{
    if is_screen_or_tmux_running; then
        ! is_exists 'tmux' && return 1

        if is_tmux_runnning; then
            echo "${fg_bold[red]} _____ __  __ _   ___  __ ${reset_color}"
            echo "${fg_bold[red]}|_   _|  \/  | | | \ \/ / ${reset_color}"
            echo "${fg_bold[red]}  | | | |\/| | | | |\  /  ${reset_color}"
            echo "${fg_bold[red]}  | | | |  | | |_| |/  \  ${reset_color}"
            echo "${fg_bold[red]}  |_| |_|  |_|\___//_/\_\ ${reset_color}"
        elif is_screen_running; then
            echo "This is on screen."
        fi
    else
        if shell_has_started_interactively && ! is_ssh_running; then
            if ! is_exists 'tmux'; then
                echo 'Error: tmux command not found' 2>&1
                return 1
            fi

            if tmux has-session >/dev/null 2>&1; then
                # セッションが存在する場合は、すべてのセッションを表示する（アタッチ済みのものも含む）
                tmux list-sessions
                echo -n "Tmux: attach? (y/N/num/new) "
                read
                if [[ "$REPLY" =~ ^[Yy]$ ]] || [[ "$REPLY" == '' ]]; then
                    # 'y'または空白の場合、最初のセッションにアタッチ
                    tmux attach-session
                    if [ $? -eq 0 ]; then
                        echo "$(tmux -V) attached session"
                        return 0
                    fi
                elif [[ "$REPLY" =~ ^[0-9]+$ ]]; then
                    # 数字の場合、その番号のセッションにアタッチ
                    tmux attach -t "$REPLY"
                    if [ $? -eq 0 ]; then
                        echo "$(tmux -V) attached session"
                        return 0
                    fi
                elif [[ "$REPLY" =~ ^[Nn]([Ee][Ww])?$ ]]; then
                    # 'n', 'new'の場合、新しいセッションを作成
                    # この場合は下の新規セッション作成処理に進む
                    :
                else
                    # その他の入力の場合も新規セッション作成処理に進む
                    :
                fi
            fi

            # 新しいセッションを作成
            if is_osx && is_exists 'reattach-to-user-namespace'; then
                # on OS X force tmux's default command
                # to spawn a shell in the user's namespace
                tmux_config=$(cat $HOME/.tmux.conf <(echo 'set-option -g default-command "reattach-to-user-namespace -l $SHELL"'))
                tmux -f <(echo "$tmux_config") new-session && echo "$(tmux -V) created new session supported OS X"
            else
                tmux new-session && echo "tmux created new session"
            fi
        fi
    fi
}
tmux_automatically_attach_session

