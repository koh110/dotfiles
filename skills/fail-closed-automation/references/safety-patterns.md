# 安全設計pattern

## 1. `..foo`を誤検出しないcontainment

```js
import path from 'node:path'

function isWithin(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}
```

lexicalなabsolute pathと`realpath()`結果へ個別に適用する。root自身との一致を許可するかは明示的に決める。

## 2. 既存entryのidentity

すべてのoutput/input pairについて、以下を行う。

1. normalize済みabsolute pathを比較する
2. 存在するancestorを解決してcanonical pathを比較する
3. 両entryが存在する場合は、`dev`と`ino`を使って`lstat`とopen済みhandleの`stat` identityを比較する
4. 変更境界でopen済みidentityを再検証し、descriptor-relative/no-follow操作を優先する

一致またはidentity変化があれば拒否する。`realpath()`だけでは同じinodeを指す異なるhardlinkを検出できず、後続のancestor置換raceも防げない。platformに必要な変更primitiveがない場合、敵対的に書込み可能なfilesystemでの利用を拒否する。

## 3. 排他的なartifact ownership

```js
const handle = await fs.open(`${artifact}.lock`, 'wx', 0o600)
```

lockは、信頼できるatomic exclusive-create semanticsを持つtrusted local directory内でのみ、deterministicなsort順に取得する。network filesystemや敵対的に書込み可能なlock directoryではplatform固有のatomic protocolを使い、それがなければ拒否する。open済みhandleごとに`(dev, ino)`を記録する。逆順unlinkの前に、各lock pathnameが記録済みidentityを指すことを再検証する。欠損・置換されていれば保持してmanual recoveryが必要なfailureとする。pathname再検証はdefense in depthであり、敵対的directory内のunlinkを安全にする仕組みではない。すべての失敗cleanupが終わるまでlockを保持する。

各outputは、runごとのrandom temporary nameへexclusive/no-followで作成する。既存temporary pathは上書きせず拒否する。作成したhandleのidentityを記録する。既存targetを保持し、platformに適したatomic no-clobber/CAS protocolで公開し、公開後のidentityを記録する。現在のnameが記録済みidentityと一致する場合だけcleanupする。top-level catchでshared artifact名を削除すると、別runのoutputを削除し得る。

stale lock回復が必要なら、lock metadataへrandom run IDを記録する。stale lock回復自体もtrusted filesystem protocolで観測したexact lockをatomicにclaimする必要がある。PID存在確認だけではhost差異やPID再利用に対応できない。

## 4. 上限付きsubprocess lifecycle

outputを正確に制限する必要がある場合は、buffered convenience APIではなく`spawn()`を使う。

- runtime/OSが利用可能なdescendant group semanticsを定義している場合だけprocess groupを作成し、それ以外ではplatform固有のjob/container戦略を使う
- stdout/stderrをbufferとしてconsumeする
- evidence byteを`new TextDecoder('utf-8', { fatal: true })`へ`{ stream: true }`付きで渡し、decode errorと不完全な終端sequenceを拒否する
- 設定済みbyte数でcaptureを停止する
- timeout/overflow時はprocess groupへsignalを送り、その後`SIGKILL`へescalateする
- `close`が来ない場合でもstdio listener/streamを破棄してcontrol promiseをsettleさせる最終abandonment pathを用意する。termination未確認として報告し、lock/quarantineを保持し、artifact公開・削除を禁止する
- byte capを維持したまま、normal close、timeout、overflow、launch error、abandonmentのすべてのterminal pathでfatal decoderをdeterministicにfinalizeする。decoder failureはevidenceを拒否する

`error`、`exit`、`close`、timeout、overflowがoperationを二重resolveしないよう、one-shotの`settle()` guardを使う。

## 5. 安全な破壊sequence

```text
探索
  -> snapshot Aを検証
  -> authoritative sourceを再照会
  -> snapshot A/Bを比較
  -> registration-awareなquarantine移動（登録済みresourceの場合）
  -> quarantine済みtargetを再検証
  -> registration/indexを変更
  -> 変更結果を検証
  -> quarantineを削除
```

Git worktreeでは、Gitのadministrative pathとfilesystem pathを同期させるため、raw filesystem `rename()`ではなく`git worktree move <candidate> <random-quarantine>`を使う。Gitはatomic no-clobber/CAS destination claimを保証しない。このため、source/destination双方のparentがtrustedかつnon-adversarialで、concurrentなdestination作成・置換を脅威モデルから明示的に除外する場合だけ許可する。それ以外は通常のGit CLIでは必要なprimitiveを提供できないため拒否する。`git worktree move`が未対応または失敗する場合も拒否する。submoduleを含む未対応caseも同様である。quarantine後の検証が終わったら、`git worktree remove <random-quarantine>`をregistrationとfilesystemをまとめて変更する単一の不可逆operationとして扱い、generic sequenceのregistration/remove段階をこの1 operationへまとめる。その後、registrationとpathが両方消えたことを確認する。Gitのadministrative worktree registrationを直接編集したり、先にunregisterしてからraw filesystem削除したりしない。通常directoryでは、atomicなsame-filesystem no-clobber move/CAS primitiveを要求し、移動したidentityを記録する。利用できなければ拒否する。

quarantine後のcheckに失敗した場合は、original pathが空いており、記録済みidentityが一致する場合だけ、同じregistration-awareまたはatomic no-clobber/CAS operationで復元する。Gitで`git worktree move`を使うrollbackにも、trusted parentとdestination race除外の同じ前提を適用する。前提を満たせなければquarantineを保持して拒否する。事前のfree-path checkだけではraceがあるため不十分である。atomic destination protectionも、明示的に文書化したtrusted-parent registration-aware例外も適用できない場合、または選択したoperationが失敗した場合はquarantineを保持し、manual recovery pathを出力する。

## 6. Git worktree cleanup predicate

cleanup前に、以下をすべて要求する。

- candidateがallowlist済みroot配下の登録済み・unlocked linked worktreeである
- adapterが、協調するwriterの新規・継続変更を防ぐenforceableなexclusive cleanup authorityまたはfencing leaseを取得し、quarantine、削除またはrollback、postcondition検証、最終releaseまで保持する。Gitのworktree `locked`状態だけでは不十分である
- candidateがmain/default branch worktreeではない
- tracked、untracked、ignored-file checkがすべて空である
- candidate `HEAD`、local branch ref、期待するbranch identityが一致する
- default branchが明示されているか、authoritative remote metadataから取得されている。`main`/`master`を推測しない
- 変更直前にremote default名とOIDを再照会する
- merge evidenceがexactかつcurrentである

`git worktree move`直前と`git worktree remove`直前の両方で、authoritative remote metadataを再fetch/再照会し、同じexclusive cleanup authority/fencing leaseを保持していることを検証する。さらにworktree registration、lock state、status、ignored file、`HEAD`、branch identity、merge evidenceを再検査する。authorityは削除またはrollbackとpostcondition検証まで保持し、生存writerがtargetを変更できない状態になった後だけreleaseする。adapterがこのwriter contractをenforceできなければ無人cleanupを拒否する。古いcwd/dirfdを保持する非協調かつ敵対的same-user processはtrusted-writer脅威モデルの外部として明示する。不一致は拒否またはrollback triggerとする。

通常mergeでは、candidate `HEAD`が再照会済みauthoritative remote-default OIDのancestorであることを要求する。squash/rebase merge evidenceでは、candidate `HEAD`がmerged PRのexact head OIDと一致し、merge commit/resultが同じ再照会済みdefault OIDから到達可能であることを要求する。通常のGit CLIではbranch checkout occupancyとref削除をatomicに調整できないため、無人cleanupではlocal branchを保持する。保持したbranchを明示的follow-upとして報告し、automationでbranch名だけを使ったforce deleteを行わない。

## 7. Snapshot/baseline比較

source languageが区別を失う可能性がある場合、各fieldをpresenceとvalueの両方で表す。

```json
{
  "field": {
    "present": true,
    "value": ""
  }
}
```

IDとsequenceを別々に保存する。mapを作る前にduplicate IDを拒否し、exactなinput key setを検証する。allowlistに基づきfieldごとに比較し、findingへbefore/after値を含める。unknown/misspelled fieldは無視するdriftではなくerrorとする。input configを上書きしたり、baseline outputをinputとaliasさせたりしない。

## 8. Strict JSON verdict

通常の`JSON.parse()`はduplicate keyの最後の値を保持して受理する。security/quality gateでは、duplicate-aware parserまたは正式なJSON tokenizing passを使い、全object depthでdecode後のduplicate keyを検出する。escapeやnestingを正しく扱えないtext regexの事前scanでは不十分である。その後、以下を要求する。

- exactなtop-level key set
- exactなarray/string/object type
- unknown propertyなし
- exactなruntime identity evidence
- blocking arrayが空

transcriptとverdict candidateはrunごとのnameへ書き、不正outputを診断可能なまま保持する。lockが証明するのは排他であり、既存shared verdictのownershipではない。記録済みidentityが一致するcurrent runのnameだけを削除またはinvalidateする。ownershipのないstale artifactは保持するかregistration-aware quarantineへ移し、それができなければ拒否してmanual recoveryを要求する。
