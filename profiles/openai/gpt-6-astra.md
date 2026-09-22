# GPT-6 Astra profile

Applies only when the active model is exactly GPT-6 Astra.

Source: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra

- 必要なdoc/referenceだけをcontextualに読む。taskと無関係なrepo mapやdoc stackを先読みしない。
- genericな「必ずtestしろ」「必ずcheckしろ」を追加で重ねない。repository policyとDefinition of Doneに必要な検証を行う。
- safeでreversibleなlocal workflowでは、policy上のapproval boundaryが無い限り各stepごとに停止しない。
- first implementationを完了とみなさず、明示されたDefinition of Doneまで継続する。
- policyが要求していないreview checkpointを増やして早期停止しない。
