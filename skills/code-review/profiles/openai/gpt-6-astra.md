# GPT-6 Astra overlay

Applies only when the active model is exactly GPT-6 Astra.

Source: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra

- `policies/default.md` が要求するreview gateだけを適用し、モデル補正のために追加review checkpointを増やさない。
- reviewが発火した場合は `SKILL.md` のsemantic contractをそのまま使う。
