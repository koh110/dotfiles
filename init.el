;;===================================================================
;;ロードパスの設定
;;====================================================================
;(add-to-list 'load-path "~/.emacs.d/")
(setq load-path
    (append
    (list
    (expand-file-name "~/.emacs.d/")
    (expand-file-name "~/.emacs.d/lisp/")
    )
    load-path))

;;====================================================================
;; 背景の設定
;;====================================================================
;;(set-background-color "black")
;;(set-foreground-color "#55ff55")
;透過設定
;(setq default-frame-alist
;      (append
;       (list
;        '(alpha . (85 40))
;        ) default-frame-alist))

;;====================================================================
;; *.~ とかのバックアップファイルを作らない
;;====================================================================
(setq make-backup-files nil)
;; .#* とかのバックアップファイルを作らない
(setq auto-save-default nil)

;;====================================================================
;;起動直後のfind-fileのパスを設定
;;====================================================================
(cd "~/")

;;====================================================================
;; 日本語環境設定
;;====================================================================
(set-language-environment "Japanese")
(set-language-environment-coding-systems "Japanese")
;;UTF-8をデフォルトにする
(set-default-coding-systems 'utf-8)
;;極力UTF-8とする
(prefer-coding-system 'utf-8)

;;====================================================================
;; org-modeの設定
;;====================================================================
;; org-modeの初期化
(require 'org-install)
;; orgファイルの関連付け
(add-to-list 'auto-mode-alist '("\\.org$" . org-mode))
;;折り返しの有効
(setq org-startup-truncated nil)
;; 作業フォルダの設定
(setq temporary-file-directory "~/tmp/")
;;latex書き出し
;(setq org-export-latex-coding-system 'euc-jp-unix)
;;utf-8で書き出す
(setq org-export-latex-coding-system 'utf-8)
(setq org-export-latex-date-format "%Y-%m-%d")
(setq org-export-latex-classes nil)

;;====================================================================
;;auto-installの設定
;;====================================================================
(require 'auto-install)
(setq auto-install-directory "~/.emacs.d/auto-install/")
(auto-install-update-emacswiki-package-name t)
(auto-install-compatibility-setup)             ; 互換性確保
;autoinstallのpassを追加
(setq load-path (cons "~/.emacs.d/auto-install/" load-path))

;;====================================================================
;; anythingの設定
;;====================================================================
(require 'anything-startup)

;キーバインドの設定
(define-key global-map (kbd "C-;") 'anything)
(define-key global-map (kbd "C-x C-x") 'anything-M-x)
(define-key global-map (kbd "C-x C-i") 'anything-imenu)
;(define-key global-map (kbd "C-x C-f") 'anything-filelist+)
(require 'anything-config)
;(add-to-list 'anything-sources 'anything-c-source-emacs-commands)

;;====================================================================
;;javascript編集用機能の追加
;;====================================================================
(autoload 'js2-mode "js2" nil t)
;;(add-to-list 'auto-mode-alist '("¥¥.js$" . js2-mode))
(setq auto-mode-alist (cons '("\\.js$" . js2-mode) auto-mode-alist))
;;インデント自動設定を停止
;(setq js2-bounce-indent-flag nil)
;;インデントの設定
(add-hook 'js2-mode-hook
          #'(lambda ()
              (require 'espresso)
              (local-set-key "\t" '(lambda() (interactive)(insert "\t")))
              (setq tab-width 4)
              (set (make-local-variable 'indent-line-function) 'espresso-indent-line)))

;;====================================================================
;;css編集用機能の追加
;;====================================================================
(autoload 'css-mode "css-mode")
(setq auto-mode-alist
	  (cons '("\\.css\\'" . css-mode) auto-mode-alist))
(setq cssm-indent-level 4)
(setq cssm-indent-function #'cssm-c-style-indenter)
(add-hook 'css-mode-hook
  #'(lambda ()
        (setq tab-width 4)
        (local-set-key "\t" '(lambda() (interactive)(insert "\t")))
))

;;====================================================================
;;行番号の表示
;;====================================================================
(require 'linum)
(global-linum-mode)

;;====================================================================
;;popup表示機能の追加
;;====================================================================
(require 'popwin)
(setq display-buffer-function 'popwin:display-buffer)

;;====================================================================
;;html-modeの設定
;;====================================================================
(add-hook 'html-mode-hook
    '(lambda()
       (local-set-key "\t" '(lambda() (interactive)(insert "\t")))
       (local-set-key "\d" 'delete-backward-char)
       (setq tab-width 4)))
