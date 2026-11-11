# omi-squad — Design Patterns và Implementation Playbook

Phiên bản 1.0 · 10/11/2026. Áp dụng cùng `architecture.md` và `tech-stack.md`. Các ví dụ là mẫu thiết kế, không phải code production đã chạy.

## 1. Bản đồ pattern

| Pattern | Áp dụng cho | Nơi đặt |
|---|---|---|
| Clean Architecture / Ports and Adapters | Tách policy khỏi CLI/DB/GitHub | domain, application, infrastructure, interfaces |
| Functional core, imperative shell | Quy tắc thuần, I/O ở biên | domain / application + infrastructure |
| Explicit state machine | Run/step/approval/rework | domain/runs, domain/approvals |
| Strategy + Adapter | Chọn và gọi Claude Code/Codex | domain/agents + infrastructure/executors |
| Repository + transaction boundary | State và invariant lưu trữ | application/ports + persistence |
| Transactional outbox | Đồng bộ GitHub và external side effect | application/use-cases/sync + infrastructure |
| Idempotency + reconciliation | Timeout/restart không tạo trùng | operation key + remote mapping |
| Lease + fencing | Không chạy trùng và không ghi đè workspace | domain policy + persistence/process |
| Checkpoint + artifact manifest | Resume độc lập công cụ | application + artifact adapter |
| Optimistic concurrency | Review/approval gắn revision | domain/delivery + GitHub adapter |
| Policy gate | Điều kiện duyệt/merge/deploy | domain policy + application use case |
| Bulkhead + bounded retry | Giới hạn lỗi theo profile/task | scheduler/profile manager |
| Manual dependency injection | Composition rõ, dễ test | bootstrap/container.ts |

Không triển khai mỗi pattern thành một framework con. Chỉ thêm abstraction khi có boundary, invariant hoặc adapter thực sự.

## 2. Ports and Adapters

Application định nghĩa cái nó cần; infrastructure thực hiện. CLI nhận input và gọi use case. Domain không biết `gh`, SQLite, Commander hoặc CLI model.

```ts
// src/application/ports/agent-executor.ts
export interface AgentExecutor {
  probe(input: ProbeRequest): Promise<ProbeResult>;
  start(input: ExecutionRequest): Promise<ExecutionHandle>;
  cancel(handle: ExecutionHandle): Promise<void>;
  collectResult(handle: ExecutionHandle): Promise<ExecutionResult>;
}
```

Các type ở ví dụ phải lấy từ contract tương ứng, không tự khai báo lại ở từng adapter. `ExecutionHandle` dùng ID trung lập, không leak object SDK riêng ra domain. Adapter registry được bootstrap truyền vào selector/use case; không `if (tool === ...)` rải trong mọi file.

Không tạo generic `BaseAgent`, `BaseRepository<T>`, `BaseService` chỉ để giảm vài dòng. Claude và Codex có thể khác cách parse/auth; interface chung chỉ chứa khả năng thực sự cần dùng.

## 3. Functional core và domain policy

Policy nhận dữ liệu đã chuẩn hóa, trả quyết định thuần và reason code. Application thu thập dữ liệu qua port, gọi policy, rồi thực hiện side effect.

```ts
type MergeDecision =
  | { allowed: true }
  | { allowed: false; reason: "STALE_REVISION" | "GATE_FAILED" | "APPROVAL_REQUIRED" };

export function evaluateMerge(input: MergeInputs): MergeDecision {
  if (input.reviewedHead !== input.currentHead || input.checkedBase !== input.currentBase) {
    return { allowed: false, reason: "STALE_REVISION" };
  }
  if (!input.requiredChecksPassed || !input.independentReviewPassed) {
    return { allowed: false, reason: "GATE_FAILED" };
  }
  if (!input.requiredApprovalsValid) {
    return { allowed: false, reason: "APPROVAL_REQUIRED" };
  }
  return { allowed: true };
}
```

Không gọi GitHub trong `evaluateMerge`. Không để reviewer text “LGTM” trực tiếp bypass gate. Không nhét toàn bộ workflow state vào một object mutable dùng chung giữa các worker.

## 4. State machine tường minh

Mọi transition phải có trạng thái nguồn, event, precondition và trạng thái đích. Application không tự update cột status tùy ý.

| Transition | Điều kiện |
|---|---|
| Pending → Ready | Dependency đạt, input hợp lệ, scope cho phép |
| Ready → Running | Có lease, executor phù hợp, context đã lưu |
| Running → Succeeded | Result hợp lệ và step gate đạt |
| Running → Interrupted | Process/session gián đoạn, chưa kết luận chất lượng |
| Running → Waiting resource | Limit/lỗi tài nguyên, đã dừng writer cũ |
| Waiting approval → Ready | Approval đúng subject/revision/actor |
| Interrupted → Ready | Đối soát xong, không còn process cũ, checkpoint hợp lệ |

State transitions dùng compare-and-swap/version hoặc transaction với điều kiện trạng thái cũ. Event đến muộn của attempt cũ không được ghi đè attempt mới.

Rework 2 + Architect + 2 là state machine riêng của chu kỳ chất lượng. Lưu `phase`, `failedCycles`, `architectInterventionId`; không chỉ một biến retry dùng cho cả HTTP, model limit và lỗi nghiệp vụ.

## 5. Strategy selection và capability policy

Candidate có tool/model/profile, capabilities, availability và concurrency. Policy lọc điều kiện bắt buộc trước, rồi mới xếp hạng preference. Thay đổi thứ tự preference không được làm mất minimum capability.

Ví dụ: step review cần khả năng đọc diff và trả result schema. Nếu Codex sẵn nhưng model được phép không đạt yêu cầu, không chọn chỉ vì còn quota. Nếu không có candidate, trả `WAITING_RESOURCE` và giải thích điều kiện thiếu.

Profile availability là quan sát có timestamp/TTL, không phải thuộc tính vĩnh viễn. Circuit state theo account group để tránh chuyển giữa hai profile cùng quota và lặp vô ích. Authentication failure yêu cầu login; không xử lý giống rate limit.

## 6. Repository và transaction

Port theo mục đích: `RunStore`, `ApprovalStore`, `OperationStore`; tránh expose SQL query builder ra application. Adapter map row sang domain rõ ràng, validate dữ liệu cũ khi migration cần.

Transaction boundary bao quanh một invariant: cập nhật step state, ghi event và outbox record phải cùng commit. Không có transaction bao quanh toàn bộ workflow kéo dài hàng giờ.

Pseudo-flow:

```text
Validate command and expected state
Begin local transaction
  Compare expected version
  Apply domain transition
  Persist new state and event
  Insert outbox operation if needed
Commit
Execute remote operation outside transaction
Record observed result in a new transaction
```

Đây là thuật toán, không phải minh họa topology. Với driver đồng bộ, callback transaction phải đồng bộ; remote await nằm ngoài. Kiểm tra affected row count để phát hiện concurrency conflict.

## 7. Transactional outbox và idempotency

Mỗi thao tác ngoài local DB có `operationKey`, `kind`, `subject`, `payloadHash`, `status`, `attemptCount` và remote ID khi biết. Operation key được tạo từ ý định ổn định, không chỉ UUID mới ở mỗi retry.

Ví dụ `create-pr:<repo-id>:<task-id>:<branch>:develop` là logical key; payload cập nhật có version/hash riêng. Merge operation gắn PR ID và expected head; deploy gắn artifact digest + environment + approval ID.

Khi API timeout:

1. Đánh dấu kết quả chưa rõ, giữ operation.
2. Tìm remote resource theo ID/branch/marker/dispatch correlation.
3. Nếu đã thành công, ghi nhận thay vì gọi lại.
4. Nếu chắc chắn chưa xảy ra, retry theo backoff.
5. Nếu không đủ bằng chứng, chờ đối soát hoặc PO; không đoán.

Trạng thái của operation: `pending` → `in_flight` (ghi trước khi gọi) → `succeeded`, hoặc `outcome_unknown` khi timeout/crash. Từ `outcome_unknown` chỉ có hai lối ra, đều qua đọc remote: tìm thấy marker thì `succeeded`, không thấy sau grace period thì quay lại `pending`. Máy trạng thái ở `domain/delivery/outbox-operation.ts`, quyết định ở ADR-0025.

Không dùng thuật ngữ exactly-once như bảo đảm tuyệt đối. Local unique constraint chỉ ngăn duplicate local; API đã nhận request nhưng mất response vẫn cần remote reconciliation.

## 8. Lease, fencing và concurrency

Resource lease áp dụng cho project runtime, worktree writer, profile slot và merge queue. Lease có owner, generation tăng dần và expiry. Completion event phải mang generation; event stale bị từ chối.

Fencing trong DB không chặn được process cũ tiếp tục ghi file. Vì vậy không cấp worktree cho writer mới chỉ vì lease hết hạn; phải xác nhận process cũ đã dừng hoặc cách ly workspace mới rồi reconcile. Không có hai writer trên cùng checkout.

Merge serialize giải quyết cạnh tranh nội bộ; vẫn phải đối soát người dùng/CI thay đổi remote ngoài framework. Lock local không thay thế optimistic concurrency trên GitHub.

## 9. Checkpoint bằng artifact manifest

Manifest là danh sách đầu vào/đầu ra và hash, cùng state nghiệp vụ. Context summary giúp agent hiểu nhưng không thay thế diff/file/test thực tế.

Ghi file atomic theo thứ tự: temp file → fsync file → công bố không ghi đè bằng hard link → unlink temp → fsync thư mục khi được hỗ trợ → DB reference. Recovery phát hiện file thiếu/hash lệch phải báo, không tiếp tục như checkpoint hợp lệ.

`ArtifactStore` (`application/ports/artifact-store.ts`) công bố artifact bất biến bằng đường dẫn
tương đối. `createLocalArtifactStore` nhận thư mục gốc đã tồn tại do runtime sở hữu và kết nối
SQLite. Adapter ghi temp trong cùng thư mục với quyền `0600`, fsync và đóng file **trước khi**
mở transaction. Transaction đồng bộ hiện có chỉ bao quanh kiểm tra ID/path trong DB,
`linkSync(temp, target)`, `unlinkSync(temp)`, fsync thư mục và insert reference. Hard link thất
bại với `EEXIST` nếu đích đã tồn tại, kể cả do process ngoài ghi vào sau khi kiểm tra path;
adapter trả lỗi có kiểu `ALREADY_EXISTS` và giữ nguyên file đó. Các thư mục cha mới tạo cũng
được fsync. Cách này tuần tự hóa phần công bố giữa các writer hợp tác mà không giữ khóa DB
trong lúc ghi và fsync toàn bộ nội dung file.

Khi công bố thất bại sau hard link (kể cả unlink temp, fsync thư mục, INSERT hoặc COMMIT),
adapter rollback file đích chỉ khi `lstat` xác nhận file thường có cùng device/inode với
`fstat` của temp đã ghi. File do writer khác tạo hoặc thay thế được giữ nguyên. Dọn temp và
rollback là best effort; lỗi dọn dẹp thứ hai không được che lỗi gốc. Khi filesystem cho phép
dọn dẹp, retry cùng path thành công. Process bị kill hoặc filesystem từ chối unlink vẫn có
thể để lại file chưa tham chiếu; `read` và `manifest` chỉ phục vụ file có DB row. Recovery và
retention cho những file còn lại thuộc vòng đời checkpoint ở task sau.

Adapter yêu cầu hard link trong cùng filesystem; không fallback sang rename có thể ghi đè.
`EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `EXDEV` và `ENOSYS` từ `linkSync` trả lỗi có kiểu
`HARD_LINK_UNSUPPORTED` và dọn temp. Chọn artifact root trên filesystem hỗ trợ hard link và
quyền tạo link; không bảo đảm hỗ trợ mọi mount/volume. Các lỗi I/O khác giữ nguyên lỗi gốc.
Kiểm tra các thành phần path từ chối symlink, kể cả link trỏ vào trong root; đây không phải
sandbox chống process cùng user cố ý đổi thư mục trong lúc I/O.
`read` đối chiếu hash đã ghim và hash trong DB với bytes thực tế. `manifest` chỉ kiểm tra các
reference được yêu cầu và lấy kích thước byte từ file vì schema v1 không có cột size. Khi cần
reference manifest bền vững, lưu JSON đó bằng `write`; không cần migration.

`assembleContext` (`application/services/assemble-context.ts`) là hàm thuần: bên gọi cung cấp
catalog đã resolve với selector role và step tường minh; cả hai phải khớp. Hàm giữ nguyên hash
tổng hợp của skill từ `skills.lock.json` (ADR-0019), version/hash của rule, từ chối ID/path
trùng trong phần được chọn và tạo packet v1 hiện có. Resolve template thuộc OMI-032; kiểm tra
file skill/rule khi dispatch thuộc loader tương ứng. Bản tóm tắt có nguồn được lưu thành
artifact chứa nội dung tóm tắt và path/hash nguồn, rồi chọn bằng reference; v1 không thêm trường
summary/transcript inline. Số Issue xác định nguồn của task snapshot. Văn bản đầu vào không
thể tự cấp approval hoặc mở rộng scope đã truyền vào.

Guard thuần (`application/contracts/credential-input.ts`) từ chối đường dẫn credential, các
field credential/environment có tên xác định và giá trị bí mật nhận diện được trước khi công
bố artifact hoặc lắp packet. Tên field phải khớp toàn bộ để các thống kê token vẫn hợp lệ;
assignment được nhận diện qua tên chỉ rõ secret (kể cả prefix chữ thường, `DB_PASS`,
`PGPASSWORD`) và giá trị literal: chuỗi có quote không chứa template expression, hoặc giá trị
không quote dài ít nhất 8 ký tự có số hay dấu của token. Bearer còn nhận diện từ opaque dài
ít nhất 24 ký tự. Các nhánh này bỏ qua từ thông thường, type, lời gọi hàm và template
expression trong các trường hợp đã kiểm thử; chúng không phải parser TypeScript hay bộ
phân loại mọi câu văn. Guard nhận diện thêm định dạng key AWS, Slack, GitLab, PEM và URL có
user/password. Ví dụ khai báo biến lấy token qua hàm, field password có type `string` và
câu “Bearer tokens are short-lived” được chấp nhận.

Quyết định cho OMI-032/loader ([ADR-0022](../architecture/adr/0022-credential-reference-boundary.md)):
cho phép nhắc tên thư mục config `.claude/`, `.codex/`, cây profile, `.npmrc`, `CODEX_HOME` và
`CLAUDE_CONFIG_DIR` trong văn bản. Tên thư mục không chứng minh có credential. Vẫn chặn file
credential xác định (cache auth JSON, file credentials JSON, file môi trường, key SSH,
file netrc, credential Git, file credentials AWS và hosts của gh); tên file `credentials`
không phần mở rộng được nhận diện khi kết thúc chuỗi/path hoặc có delimiter quote/dấu câu, không suy
ra từ cặp từ trong prose như state/credentials. Nội dung `.npmrc` có assignment `_authToken`,
`_auth` hoặc `_password` vẫn bị chặn. Field environment/credential trong object và policy
được bên gọi cung cấp vẫn bị chặn như trước. Ngoại lệ chỉ dành cho tham chiếu config thông
thường, không có allowlist theo tên tài liệu. Loader có thể lưu tóm tắt có nguồn và quote
những tên config này, nhưng vẫn phải chạy guard trên toàn bộ đầu vào và giữ hash nguồn;
không đọc/copy auth file để đưa vào context. Corpus integration nạp nguyên văn
`architecture.md` và `compatibility.md` qua cả write/read artifact.

Bên gọi tại bootstrap phải truyền giá trị môi trường nhạy cảm đã biết và root credential tùy chỉnh qua
`CredentialPolicy`; service/store không tự đọc môi trường hoặc nội dung profile. Nội dung
artifact JSON được kiểm tra cả cấu trúc lẫn văn bản. Nhận diện bằng pattern chỉ là best effort
(tech-stack.md §9), không chứng minh mọi bytes không có nhãn đều không chứa bí mật. Chỉ lấy
đầu vào đã review cho catalog; không thu thập cả repository, môi trường hoặc cây profile.
Lỗi không lặp lại credential bị từ chối.

Khi đổi tool/profile, tạo attempt mới, dùng checkpoint cùng task/run. Không sửa transcript tài khoản khác để giả lập continuation. Nếu có native resume cùng profile thì dùng như tối ưu sau khi đã kiểm chứng, không thành dependency của sản phẩm.

## 10. Approval như một quyết định có phiên bản

Approval gắn `kind`, `subjectId`, `subjectHash`, `scope`, `actor`, `source`, `timestamp`, `decision`. Release approval gắn PR/head; deployment approval gắn digest/environment; business approval gắn baseline yêu cầu.

Không chỉ lưu `approved: true` trong task. Khi nội dung thay đổi, policy quyết định approval nào stale. Thay đổi file README không nhất thiết vô hiệu business approval, nhưng head review/CI phải cập nhật theo gate đã định nghĩa. Không xin duyệt lại phần nghiệp vụ không đổi một cách máy móc.

Quyền agent rộng theo PO chọn, nên enforcement local là hợp tác. Review/approval giả lập bởi cùng GitHub identity không được coi là native approval của PO. Với hành động nhạy cảm, ưu tiên xác nhận actor và gate ở GitHub/pipeline độc lập với worker.

## 11. Bounded retry, backoff và bulkhead

| Lỗi | Chính sách |
|---|---|
| Code/test/review không đạt | Quality cycle 2 + Architect + 2 |
| Rate/usage limit | Cooldown, checkpoint, chọn profile đủ năng lực |
| Login hết hiệu lực | Login-required, không retry vô hạn |
| Network tạm thời | Exponential backoff có jitter, retry budget |
| Invalid config/schema | Fail fast, thông báo field và sửa config |
| Remote outcome unknown | Reconcile trước retry |
| Task thiếu quyết định PO | Waiting approval, không tiêu hao quality retry |
| Process chết/WSL restart | Interrupted, recovery trước dispatch |

Bulkhead giới hạn agent theo tool/profile/task. Một profile hỏng không chặn toàn squad. Backoff dùng clock có thể fake trong test; không hardcode sleep dài trong use case. Lỗi không phân loại được thì giữ evidence và dừng an toàn, không tự nhận là limit.

## 12. Dependency injection và composition root

Bootstrap tạo config loader, SQLite store, process manager, Git/GitHub adapters, executor registry và use cases; truyền qua constructor/function parameter. Không dùng service locator global để bất kỳ file nào cũng truy cập database hoặc spawn worker.

Clock, ID generator và logger cũng là dependency khi ảnh hưởng determinism. Unit tests dùng fake ports; integration tests dùng adapter thật. Không mock sâu implementation private chỉ để làm test pass.

## 13. Quy trình implement một task

1. Đọc Issue/AC, overview, bản đồ folder và ADR liên quan.
2. Xác định layer/file dự kiến trước khi sửa; kiểm tra có module phù hợp đã tồn tại.
3. Viết/điều chỉnh domain policy và contract trước khi thêm I/O nếu task liên quan hành vi mới.
4. Viết test chứng minh invariant hoặc lỗi thực tế; không viết test chỉ lặp implementation.
5. Implement use case qua port, adapter ở đúng vị trí, wiring tại bootstrap.
6. Kiểm tra lỗi, cancellation, retry và recovery nếu có side effect.
7. Chạy checks phù hợp; cập nhật schema/docs/ADR khi contract thay đổi.
8. Reviewer độc lập kiểm tra code revision và bằng chứng; sửa tới khi pass hoặc áp dụng giới hạn 2 + 2.
9. PR link Issue; không đánh Done trước merge develop và đối soát thành công.

## 14. Anti-pattern phải chặn

- CLI handler gọi SQL, GitHub và spawn process trực tiếp.
- Một file `coordinator.ts` chứa toàn bộ parsing, scheduling, retry, Git và DB.
- Agent thay status bằng cách tự sửa SQLite.
- Workflow YAML chứa shell command ghép từ Issue body mà không validate.
- Native auth global bị đổi qua lại giữa worker song song.
- Tự clone toàn repository/state cho từng step bất kể nhu cầu.
- Reviewer đọc worktree đang thay đổi và approve một revision không xác định.
- Token/auth file trong log, checkpoint hoặc GitHub comment.
- Tạo nhiều Issue cho từng step review/test mặc dù không có bàn giao độc lập.
- Dùng rule “always ask user” cho mọi quyết định kỹ thuật, trái mức tự chủ đã chốt.
- Tự thêm Redis/ORM/web server khi chưa có yêu cầu rõ.
- Tắt test/architecture rule hoặc giảm gate chỉ để task hiện tại pass.

## 15. Quality checklist theo loại thay đổi

| Thay đổi | Bằng chứng tối thiểu |
|---|---|
| Domain policy | Positive/negative/boundary tests, không I/O |
| Persistence | Transaction rollback, migration, restart test |
| Agent adapter | Success/failure/limit/malformed output fixtures và cancellation |
| Git/GitHub side effect | Duplicate prevention, timeout-after-success, stale revision |
| Approval | Wrong actor, wrong revision, rejection và expiry/invalidation |
| Scheduler | Dependency cycle, concurrency cap, no two writers, blocked propagation |
| Checkpoint | Missing/hash mismatch, crash between writes, reconciliation |
| Packaging/init | Clean install, existing config preservation, no secret in artifact |

Đây là engineering rules của omi-squad. Những phần tham khảo từ Superpowers/Taste/Ponytail/UI UX Pro Max phải được chuyển thể có chủ đích và ghi provenance; không để hướng dẫn bên ngoài tự thay đổi các quy tắc sản phẩm hoặc quyền PO.
