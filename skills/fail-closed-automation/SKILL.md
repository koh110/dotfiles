---
name: fail-closed-automation
description: 破壊的・無人・外部ツール依存の自動化を、不確実な状態では変更せず安全に拒否するfail-closed方式で設計・レビューする。ファイルシステムcleanup、Git/worktree cleanup、subprocess runner、生成artifact、設定/baseline監査、外部review gate、symlinkを考慮した探索、TOCTOU対策、または削除・上書き・公開・evidence受理を行うCLI/cron/CIで使用する。
---

# Fail-Closed自動化

## 基本原則

変更をprogramの既定分岐ではなく、証明の最終段階として扱う。evidenceが欠損・古い・曖昧・読取不能・不正・timeout・競合のいずれかなら変更を拒否し、失敗したpredicateを特定する。

製品/runtime固有の解決処理はadapterに置き、安全性のcoreを特定のscheduler、model provider、repository host、config schemaから独立させる。各adapterはauthoritativeな鮮度判定clock、active writer/lease契約、identityの粒度、evidenceの再読込地点を定義する。domain contractが欠けている場合は推測せず拒否する。

## Workflow

1. asset、変更境界、外部evidence、rollback限界を列挙する。
2. 変更を実装する前に、すべての安全predicateを記述する。
3. 純粋な探索・検証とside effectを分離する。
4. lexical pathと解決後のfilesystem identityを検証する。
5. 変更直前にvolatileなevidenceを再読込する。
6. 可逆なstagingが可能なら、破壊対象を境界内のrandom quarantineへ移す。
7. quarantine後かつ不可逆削除前に、安全predicateを再実行する。
8. すべての拒否理由を構造化して出力し、errorを暗黙にskipへ格下げしない。
9. 正常系と、各拒否・race経路の両方をtestする。

実装patternは[references/safety-patterns.md](references/safety-patterns.md)を参照する。

## Filesystemとartifactの規則

- `path.resolve()`によるcontainmentと`realpath()`によるcontainmentの両方を探索時checkとして検証する。これらは変更時のrace protectionではない。
- 変更時はdescriptor-relative/no-follow操作を優先し、可能な限り最後の時点で`lstat()`またはopen済みhandleの`(dev, ino)` identityを比較する。platformが必要なprimitiveを提供できない場合、敵対的filesystemでの利用を拒否する。
- 親逸脱は`relative === '..'`または`relative.startsWith('..' + path.sep)`で判定する。`..cache`のような無害な名前を拒否しない。
- broken symlink、symlink cycle、読取不能なfile/directory、root外を指すsymlink露出を個別に検出する。`realpath()`の`ENOENT`/`ENOTDIR`だけでは、本当に欠損したpathとbroken symlinkまたはsymlink配下のpathを区別できない。欠損を許容する場合は`lstat()`で最も近い既存祖先まで遡り、祖先がdirectoryで`realpath(祖先) === 祖先`の場合だけ欠損として扱い、それ以外は拒否する。記録済みpathは検証時と利用直前の両方で再解決し、canonical pathが記録値と一致することを確認する。
- 出力を書き込む前に、存在するentryのcanonical pathと`(dev, ino)`を使い、すべてのinput/output間およびoutput/output間のsame path、symlink target、hardlink aliasを拒否する。
- 排他lockは、信頼できるatomic exclusive-create semanticsを持つfilesystem上のtrustedかつnon-adversarialなdirectory内でのみ取得する。それ以外はplatform固有のatomic protocolを使うか拒否する。open済みlock identityを記録し、逆順で解放し、現在のlock pathnameが同じidentityを指す場合だけunlinkする。pathが欠損・置換されていたら保持して失敗する。
- 出力はrunごとのrandom temporary nameへexclusiveかつno-followで作成する。既存名があれば上書きせず拒否し、作成・公開時の`(dev, ino)`を記録する。既存targetを保持し、現在のnameが当該runのidentityと一致する場合だけcleanupする。
- lock解放後に失敗cleanupを実行しない。stale lock回復は独立したatomic fail-closed protocolとして扱う。
- quarantine/temporary nameには暗号学的random値を使い、atomic moveに依存する場合は同一filesystem上に置く。quarantineとrollbackには、記録したidentityを伴うatomic no-clobber/CAS semanticsが必要である。そのprimitiveを提供できないregistration-aware toolは、source/destinationのparentがtrustedかつnon-adversarialで、concurrentなdestination作成・置換を脅威モデルから明示的に除外できる場合だけ許可し、それ以外は拒否する。

## Subprocessの規則

- 有限timeoutと、user設定可能timeoutの明示的な上限を設ける。
- stdoutとstderrを個別に、または文書化した合計上限で制限する。上限付きevidenceへ切り詰めmarkerを付ける場合、marker bytesも同じ上限に含めて本文量を先に制限し、markerを追加しても上限内に収める。残りbudgetがmarker未満なら本文を追加せず、既に上限内で保持したprefixはそのままにする。producer側overflowで停止した場合は、textにmarkerを収められないときもtruncation状態を別の構造化fieldで必ず報告する。
- evidence streamはfatalなstreaming UTF-8検証でdecodeし、不正byteや不完全な終端sequenceを拒否する。evidenceではない診断logは、明示的に分離した場合のみreplacement decoderを使用できる。
- process groupはruntime/OSが定義済みのgroup/session semanticsを提供するplatformでのみ作成し、それ以外ではplatform固有のcontainment戦略を使う。process groupへのsignalは、`setsid()`/`setpgid()`で別session/groupへ移った子孫には届かず、parent processのmemoryにだけあるcleanupはparent crash後に実行されない。子孫をrunner終了後も残せない場合は、parent crashを越えて存続するOS-level containmentを使う（Linuxではsystemd unit/cgroupなど）。利用できないplatformではこの制限を明示し、必要なcontainmentを保証できないなら拒否する。
- timeoutまたはoutput overflow時はterminationを段階的に強化し、`close`が来なくてもparent promiseが必ずsettleするようにする。termination未確認はhard failureとして扱い、生存childが変更できるartifactの公開・削除やisolation解放を行わない。
- launch failure、timeout、output overflow、signal exit、non-zero exit、不正output、semantic rejectionを区別する。
- 呼び出し側が子processのfailure kindで分岐する場合は、dedicated/documented exit codeで分類する。stderrには利用者制御の値が含まれ得るため、message textをparseして許容側へ分類してはならない。明示的に許可したfailure codeだけをrecoverableとして扱い、それ以外のnon-zero exitは失敗とする。
- startup banner、呼出引数、self-reportされたmodel/provider名は補助的かつuntrustedなevidenceとして扱う。identity-sensitive gateではprovider/runtime responseからauthenticated observed identityを得られない、または一致しない場合に拒否する。要求したidentityは実際に実行されたidentityの証明ではない。
- Agent sessionの成功判定では、最後のassistant messageの終了理由を確認し、`error`/`aborted`等の終了を成功扱いしない。途中まで出力されたtextだけを成功のevidenceにしてはならない。

## Baselineとverdictの規則

- baselineとinput schemaをversion管理し、検証対象の各object levelでexactな許可key setを要求する。未対応versionやunknown/misspelled fieldをmigration推測で補わず拒否する。
- 順序に意味がある場合はsequenceを保持する。
- field欠損、`null`、空文字列、空配列、`false`を区別する。
- 明示的にallowlistしたfieldだけを比較し、新規ID、duplicate ID、欠損ID、未承認field変更を拒否する。
- validation errorがある状態ではbaselineの書込みや承認を拒否する。
- 外部verdictをstrict schemaで検証し、duplicate JSON key、unknown key、string以外のfinding、model identity mismatchを拒否する。
- blocking finding fieldをすべて列挙した明示的かつversion付きのacceptance policyを定義する。unknown/renamed severity fieldを拒否し、policyに列挙されたすべてのblocking fieldが空の場合だけgateを通す。

## TOCTOUと外部evidence

- 初回観測を記録し、変更直前にauthoritative sourceを再照会する。
- path identity、object ID、ref名、commit/OID、generation/versionなど、identityと値の両方を比較する。
- sourceが変化していたらmixed snapshotのまま続行せず、拒否して探索をやり直す。
- exact identifierが利用できる場合は間接evidenceを受理しない。
- 脅威モデルを明示する。quarantineは通常のpath-based writerを遮断するが、古いcwd/dirfdを保持する敵対的same-user processは遮断できない。

## 検証matrix

最低限、以下を対象にする。

- 正常operation
- dirty/untracked/ignored/unreadable input
- 欠損・不正evidence
- symlink escape、hardlink alias、symlink cycle
- 実際の欠損pathとbroken symlink／symlink ancestorの区別、およびrecord済みpathの検証後に行われるsymlink置換
- stale snapshot、check間での値変更
- timeout、output overflow、不正UTF-8、不完全な終端UTF-8 sequence
- truncation markerを含めたbyte上限、markerより小さい残りbudget、producer側overflow
- launch failure、non-zero exit、signal exit、parent終了後も生存するdescendant
- `setsid()`等で別groupへ移る子孫と、runner parentを強制終了した後の子process containment
- agent sessionの最終終了理由がerror/abortで、途中までのtextが残る場合
- 利用者制御のstderrでrecoverable error messageを偽装する入力、およびdedicated exit code以外のnon-zero exit
- 同じartifactを取り合うconcurrent run
- 既存output保持、lock pathの置換・消失、stale lock takeover拒否
- runごとのtemporary/publication衝突、quarantine名衝突、rollback destination race、cleanup identity mismatch
- rollback成功とrollback拒否
- validation後にworktreeを削除しつつ別processが同じbranchをcheckoutするrace
- 未対応baseline schemaと未承認field drift
- 不正・duplicate verdict JSON、nested unknown key、string以外のfinding、identity mismatch

実際のexecutableまたはfixtureを実行する。実行を伴わないcode reviewだけでは十分なevidenceにならない。

## 報告

以下を報告する。

- 実行した正確なcommand
- 変更件数と拒否/error件数
- 各安全拒否の理由
- evidenceとして使ったartifactまたはtranscript
- 受容した残余risk

探索自体が失敗した場合に「変更なし」を成功として報告しない。
