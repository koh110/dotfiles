# GPT-6 Astra overlay

Applies only when the active model is exactly GPT-6 Astra.

Source: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra

- repository/公式資料で解消できる曖昧さは自律的に調査し、consequentialなユーザーdecisionだけを質問する。
- 固定の質問回数や確認checkpointを追加しない。
- specのExit Criteriaが満たされるまで進めるが、policyが要求していない途中承認で早期停止しない。
