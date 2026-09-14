# Ranked research workflowの例

このreferenceは、ranked-data automationを設計するときに得られた再利用可能な構成をまとめたものです。特定repositoryには依存しません。各projectに合わせて名称や時刻を置き換えてください。

## Sequence

1. Workerがdaily source cutoff後にauthoritative ranking snapshotを更新する。
2. 朝のagent jobが最新snapshotからboundedなtop-N setを対象に `prepare` を呼ぶ。
3. Workerがexternal source dataを取得し、現在のrecordを読み、明示的なformulaを計算してrun snapshotを永続化する。
4. agentが事実をfield単位のstructured decisionへ解釈し、別のrecommendation/proposal recordとして保存する。
5. chat adapterがbefore/after/source/confidenceを受け取り、会話継続可能なthreadで人間のdecisionを待つ。
6. agentが正確なrun ID、proposal hash、confirmed entity setを指定して `apply` を呼ぶ。
7. Workerがvalidation後、entityごとに独立したtransactionでapplyし、entity単位のsuccess/failureを記録する。

## 維持すべき重要な判断

- human reviewを行う場合、confidenceは判断材料であり、自動thresholdではない。不確実性は理由付きの `skip` として明示する。
- 既存値をoverwriteしてよいのは、validかつ明示的に承認されたfresh valueだけである。取得失敗やskipされたfieldをempty stringへ変換しない。
- recommendation stateがcanonical research/value recordと別概念なら、専用tableへ保存する。
- applyはstale、expired、hash mismatch、unauthenticated、out-of-scopeなproposalをrejectする。
- entity単位のpartial successはrun resultへ表現する。誤って1つの大きなall-or-nothing transactionにしない。

## Review questions

- 既存のupsert/PUT semanticsはomitted fieldを消去しないか。
- recommendation tableをcanonical valueとは独立してauditできるか。
- chat textに依存せずduplicate applyを識別できるか。
- 朝のjobはrefresh完了を推測するのではなく、既知のsnapshot generationを利用しているか。
- schedulerのtimezoneとUTC expressionをscheduler documentationから確認しているか。
- human confirmationはrun全体だけでなく、正確なentityを特定しているか。
