---
name: skill-feedback-criteria
description: '作業中に見つかった学びを既存skillへpatchすべきか、新しいskillを作るべきか、durableな記録だけで十分かを判定するときに使う。再利用可能性・影響範囲・鮮度・記録先を切り分けるための基準。'
---

# Skill Feedback Criteria

## Goal

作業中に得た学びを、

1. 既存 skill の更新
2. 新しい skill の作成
3. issue / comment / 調査メモなど durable な記録
4. 何もしない

のどれに送るべきかを判断する。

## Quick Decision Order

1. **次回以降も同じ種類の作業で再利用されるか** を判断する
2. **既存 skill の修正で吸収できるか** を確認する
3. **skill にするほど一般化できるか** と **private/public の置き場** を決める
4. skill にしない場合でも **durable な記録を残すべきか** を判断する

## Patch Existing Skill When

- 今回の学びが、すでに存在する skill の trigger 範囲に自然に収まる
- その学びが次回の手順・禁止事項・pitfall・完了条件を実際に変える
- 「その skill を読んでいれば今回の手戻りを避けられた」と言える
- 変更内容が task 固有の結果ではなく、workflow の改善になっている

例:
- コマンドの前提条件が抜けていた
- repo-backed skill は `skill_manage` でなく source file 直patch が必要だった
- incident 調査で durable なログ記録を先に作るべきだった
- 完了条件に verification 手順が不足していた

## Create New Skill When

- 再利用可能な workflow だが、既存 skill に自然な受け皿がない
- 単発メモではなく、今後も同種タスクで読み込ませる価値がある
- 複数ステップの判断や手順があり、skill 化で挙動が安定する
- 5回前後以上の tool 呼び出し・繰り返し説明・毎回の迷いを減らせる

新 skill を作る前に確認すること:
- 既存 skill の section 追加で十分ではないか
- どのディレクトリに存在する skill が source of truth にふさわしいか

## Durable Record Only When

- 学びの中心が時刻・観測値・調査ログ・対処履歴などの **事案固有の証拠** である
- workflow そのものより、「今回何が起きたか」を残す価値が高い
- 将来参照されるとしても、skill ではなく issue / comment / 調査メモのほうが適切
- 鮮度が短く、数日〜数週間で価値が薄れる

例:
- 2026-06-25 18:27 JST に php-fpm が `pm.max_children=300` に達した
- ある障害の一時的な origin 切り分け結果
- 特定 PR / issue / インシデントに閉じた判断経緯

## Do Nothing When

- 学びが自明で、skill を読まなくても通常の実務で避けられる
- タスク固有すぎて再利用性がない
- 一週間程度で陳腐化し、durable に残すコストの方が高い
- すでに同じ内容が skill や durable record にあり、重複するだけ

## Heuristics

### skill に反映する寄りのシグナル

- 同じ説明や修正を次回また言いそう
- 「この一文があれば迷わなかった」と言える
- 失敗原因が knowledge gap で、コードや外部障害の偶然ではない
- 完了条件を変えるべきだと思った
- 別セッションの自分/他エージェントにも効く

### durable record に残す寄りのシグナル

- タイムライン、証拠、スクリーンショット、ログ抜粋が主役
- 後から「なぜそう判断したか」を監査できることが重要
- 進行中の調査で、会話圧縮に耐える外部記録が必要

## Completion Rule

この skill を使って判断したら、完了条件は「どれに残すか決めた」ではなく、**実際に反映先を更新した** こと。

- skill patch/create を選んだ → 対象 skill を更新する
- durable record を選んだ → issue / comment / 調査メモへ実際に記録する
- 何もしないを選んだ → 重複または非再利用と判断した理由を短く説明する

## Common Mistakes

- 学びを chat の最終報告だけに残して source of truth を更新しない
- 事案固有のタイムラインを skill に埋め込んでしまう
- 新 skill を作るべきところで、関係ない skill に無理やり追記する
- 「あとで skill に反映する」と言って実際には反映しない

## Verification

- 反映先は skill / durable record / no-op のどれかに明示的に分類したか
- skill を選んだ場合、その変更は task 固有の結果ではなく再利用可能な workflow 改善になっているか
- durable record を選んだ場合、後から第三者が経緯を追えるだけの証拠を残したか
- source of truth を更新したか
