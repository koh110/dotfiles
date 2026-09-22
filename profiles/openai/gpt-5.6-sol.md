# GPT-5.6 Sol profile

Applies only when the active model is exactly GPT-5.6 Sol.

Source context: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra

OpenAIのAstra向けguidanceをSolへ逆輸入しません。特に、Astraでは不要とされることがある指示を一般ルールとして削除しないためのoverlayです。

- Definition of Doneにverificationが含まれる場合、implementation後にaffected checksを明示的に閉じる。
- material ambiguityはrepository/公式資料で解消し、解消不能なユーザー決定だけを残す。
- task-specificなreferencesを使い、unrelated docsを儀式的に全読込しない。
- このprofileはreviewやapprovalのpolicyを追加・削除しない。
