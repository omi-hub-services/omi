# omi-squad — Project Plan và cây GitHub Issues

Phiên bản 1.0 · 10/11/2026. Kế hoạch triển khai từ `product-overview.md`, `architecture.md`, `tech-stack.md`, `design-patterns.md`.

**Trạng thái:** tài liệu kế hoạch; chưa tạo GitHub Project, Issue, branch hay PR thực tế. Các mã `OMI-xxx`/`EP-xx` là mã kế hoạch ổn định, không phải số Issue GitHub. Owner/repo/Project URL và tài khoản PO sẽ được xác định khi thực hiện bootstrap.

## 1. Mục tiêu và nguyên tắc

Triển khai một framework local hoạt động thật: PO giao phạm vi → Coordinator Claude Code điều phối Claude Code/Codex → workflow có gate → PR develop → Done → release main có duyệt → production deploy duyệt riêng.

Đưa rủi ro kỹ thuật lên đầu. Không chờ hoàn thiện toàn bộ thư viện skills mới thử subscription/profile/checkpoint. Không coi tạo cấu trúc thư mục là hoàn thành framework.

Mỗi Issue triển khai có bàn giao độc lập và acceptance criteria. Workflow step không mặc nhiên trở thành Issue. EP là Issue cha để nhóm kết quả; milestone là mốc GitHub, không nhân đôi thành một loại Issue khác.

## 2. Các milestone và exit gate

| Milestone | Phạm vi | Điều kiện ra khỏi mốc |
|---|---|---|
| M0 — Feasibility | OMI-001–006 | Hai CLI chạy bằng subscription; profile/lifecycle/GitHub có bằng chứng; blockers được ghi rõ |
| M1 — Core foundation | OMI-007–012 | Schema, domain, state, transaction, CLI/IPC và artifact foundation kiểm thử được |
| M2 — Execution | OMI-013–018; OMI-021, OMI-024, OMI-026, OMI-027 | Chạy worker, worktree, checkpoint/recovery, quản lý profile và failover |
| M3 — Task delivery | OMI-019, OMI-020, OMI-022, OMI-023, OMI-025, OMI-028, OMI-029, OMI-030 | Issue → workflow tối thiểu → test/review → merge develop → Done; parallel/approval hoạt động |
| M4 — Full lifecycle | OMI-031–042 | Bộ template đủ vòng đời, release và deploy có hai điểm duyệt riêng |
| M5 — v0.1 acceptance | OMI-043–048 | Fault tests, clean install, beta và release framework được PO duyệt |

Milestone là nhóm bàn giao, không phải hàng rào buộc mọi task mốc trước xong mới làm task mốc sau. Mã Issue được nhóm theo Epic, không biểu thị thứ tự thực hiện. Các task worktree/outbox/checkpoint/recovery thuộc Epic GitHub/Recovery nhưng được kéo vào M2 để failover có nền tảng đầy đủ. Khi tạo Issue, dùng mapping milestone tại bảng này, không suy ra milestone từ Epic cha.

Chưa gán ngày cố định hoặc velocity giả định. Sau M0, dùng thời gian đo thực tế và khả năng tài nguyên để bổ sung target dates. Priority thể hiện giá trị/rủi ro; dependency quyết định tính sẵn sàng.

## 3. Cây Issue theo quan hệ cha–con

| Issue cha | Mục tiêu | Sub-issues | Milestone chính |
|---|---|---|---|
| EP-01 — Bootstrap & feasibility | Xác minh nền tảng trước đầu tư lớn | OMI-001, OMI-002, OMI-003, OMI-004, OMI-005, OMI-006 | M0 |
| EP-02 — Domain & persistent state | State và contract đáng tin cậy | OMI-007, OMI-008, OMI-009, OMI-010, OMI-011, OMI-012 | M1 |
| EP-03 — Agent execution & profiles | Worker thật và failover | OMI-013, OMI-014, OMI-015, OMI-016, OMI-017, OMI-018 | M2 |
| EP-04 — GitHub & Git delivery | Task/PR/merge/Done có truy vết | OMI-019, OMI-020, OMI-021, OMI-022, OMI-023, OMI-024 | M2–M3 |
| EP-05 — Orchestration & recovery | Song song, checkpoint, retry, approval | OMI-025, OMI-026, OMI-027, OMI-028, OMI-029, OMI-030 | M2–M3 |
| EP-06 — Roles, skills & workflows | Bộ mẫu toàn vòng đời | OMI-031, OMI-032, OMI-033, OMI-034, OMI-035, OMI-036 | M4 |
| EP-07 — Release & deployment | Phát hành và deploy có kiểm soát | OMI-037, OMI-038, OMI-039, OMI-040, OMI-041, OMI-042 | M4 |
| EP-08 — Reliability & packaging | Có thể cài, dùng, phục hồi và bảo trì | OMI-043, OMI-044, OMI-045, OMI-046, OMI-047, OMI-048 | M5 |

Tổng kế hoạch ban đầu: **8 Epic Issues và 48 sub-issues**. Đây là baseline đủ để khởi tạo backlog, không giới hạn việc tách nhỏ thêm khi nghiệm thu cho thấy task quá lớn. Epic không tự Done chỉ vì tổng checklist được đánh dấu; phải kiểm tra trạng thái con và outcome của Epic.

## 4. Danh sách triển khai chi tiết

Quy ước: P0 = nền tảng/khả thi bắt buộc; P1 = chức năng cần cho v0.1. Role là người thực hiện chính; mỗi Issue vẫn có reviewer độc lập theo workflow. Các đường dẫn được hiểu từ root repository framework.

### EP-01 — Bootstrap & feasibility

| ID | Issue / role / priority | Phụ thuộc | Bàn giao và acceptance criteria |
|---|---|---|---|
| OMI-001 | Scaffold clean architecture — Architect/Developer — P0 | Không | Tạo đúng root/src/tests/docs/templates; npm scripts cơ bản, AGENTS/CLAUDE rules và architecture guard baseline; build/typecheck/lint chạy; không có file ngoài quy ước |
| OMI-002 | PoC Claude Code subscription worker — Developer — P0 | OMI-001 | Một step read-only rồi step sửa repo tạm qua CLI subscription; log/version/auth mode đã khử secret; kiểm tra success/error/cancel; không dùng API key để thay thế |
| OMI-003 | PoC Codex subscription worker — Developer — P0 | OMI-001 | Tương tự OMI-002 bằng Codex; chứng minh result có cấu trúc và auth cache phù hợp |
| OMI-004 | PoC nhiều profile và continuation — Architect — P0 | OMI-002, OMI-003 | Hai profile mỗi tool nếu PO cung cấp; isolation và checkpoint continuation; fault injection limit không bắt buộc tiêu hao thật; phân biệt lỗi giả lập với quota detection thật; ghi rõ điểm chưa chứng minh |
| OMI-005 | PoC lifecycle WSL2 — Developer — P0 | OMI-002, OMI-003 | Supervisor nhận biết Coordinator exit, dừng process group; test graceful và abrupt stop; giữ file chưa commit; không kill phiên không thuộc framework |
| OMI-006 | PoC GitHub capability — DevOps — P0 | OMI-001 | Sandbox repo/Project: đọc/ghi field, Issue/sub-issue/dependency, PR link và merge permission; xác minh actor approval, native checks, deployment gate; capability matrix rõ |

Output PoC đặt trong `tests/live/` hoặc adapter spike có ADR, evidence tóm tắt trong `docs/architecture/adr/`; code tạm không được biến thành module production ngoài cấu trúc. Nếu OMI-004 không đạt auto failover, báo blocker sản phẩm, không đóng Issue thành Done bằng phương án manual.

### EP-02 — Domain & persistent state

| ID | Issue / role / priority | Phụ thuộc | Bàn giao và acceptance criteria |
|---|---|---|---|
| OMI-007 | Contract/schema v1 — Developer — P0 | OMI-001 | Zod workflow/config/context/result/command; generated JSON Schema; reject input sai; version và schema drift test; `application/contracts`, `schemas` |
| OMI-008 | Domain policies/state machines — Developer — P0 | OMI-007 | Task/run/approval/merge/capability và 2+Architect+2; pure tests cho boundary/invalid transition; `domain/` không I/O |
| OMI-009 | SQLite schema/migration — Developer — P0 | OMI-007 | Tables/index/FK/unique từ architecture; migration checksum, WAL/FULL, restart và rollback transaction test; `migrations/`, `persistence/sqlite/` |
| OMI-010 | Transaction, leases và audit — Developer — P0 | OMI-008, OMI-009 | State+event+outbox atomic; generation/lease stale bị từ chối; một writer/worktree; test competing claim và late event |
| OMI-011 | CLI/IPC skeleton — Developer — P0 | OMI-007, OMI-009 | Commander handlers mỏng, versioned IPC, text/JSON output, framing/error/exit codes; command không truy cập SQL trực tiếp |
| OMI-012 | Artifact store & context packet — Developer — P0 | OMI-007, OMI-009 | Atomic write/hash/manifest, packet chọn lọc skills/rules/input; path validation và missing artifact test; không chứa credential |

### EP-03 — Agent execution & profiles

| ID | Issue / role / priority | Phụ thuộc | Bàn giao và acceptance criteria |
|---|---|---|---|
| OMI-013 | Production Claude adapter — Developer — P0 | OMI-002, OMI-007, OMI-012 | Port probe/start/events/cancel/result; parser fixtures success/limit/auth/malformed; version compatibility; không dùng global auth swapping |
| OMI-014 | Production Codex adapter — Developer — P0 | OMI-003, OMI-007, OMI-012 | Cùng contract của OMI-013; cấu hình auth namespace đã kiểm chứng; không leak CLI-specific object vào application |
| OMI-015 | Profile registry & selector — Developer — P0 | OMI-004, OMI-008, OMI-009 | Local metadata, TTL/cooldown/account-group/concurrency; chọn đủ capability; unknown và login-required thể hiện đúng |
| OMI-016 | Session supervisor/runtime — Developer — P0 | OMI-005, OMI-010, OMI-011 | Runtime gắn Coordinator lifecycle; single project owner; stop/grace/kill đúng process; session mới không chiếm state khi process cũ còn ghi |
| OMI-017 | Dispatch và validate result — Developer — P0 | OMI-013, OMI-014, OMI-016, OMI-021 | Cấp attempt/context/worktree; nhận result/schema/artifact; event stale không ghi đè; exit 0 không tự Done |
| OMI-018 | Failover từ checkpoint — Developer — P0 | OMI-015, OMI-017, OMI-027 | Limit → stop writer → reconcile → profile khác → attempt mới; không reset quality counter; hết candidate thì waiting_resource |

### EP-04 — GitHub & Git delivery

| ID | Issue / role / priority | Phụ thuộc | Bàn giao và acceptance criteria |
|---|---|---|---|
| OMI-019 | Init và GitHub Project mapping — Developer — P1 | OMI-006, OMI-007, OMI-011 | Detect org/user Project, field/option IDs; new template và existing mapping; preview thay đổi, không overwrite cấu hình cũ |
| OMI-020 | Import task/scope/dependencies — Developer — P0 | OMI-019, OMI-009 | Issue snapshot/hash, scope milestone/iteration/list, dependency DAG; loại draft item chưa đủ điều kiện; không chọn task ngoài scope |
| OMI-021 | Git branch/worktree manager — Developer — P0 | OMI-001, OMI-010 | Branch từ develop, worktree riêng task, phát hiện dirty user worktree; nested writers bị chặn; cleanup không mất thay đổi |
| OMI-022 | PR creation & Issue linkage — Developer — P1 | OMI-020, OMI-021, OMI-024 | PR vào develop, Issue reference/backlink/mapping đã xác minh; retry không tạo PR trùng; không dựa Closes cho non-default branch |
| OMI-023 | Review/check gates & merge — Developer/QA — P0 | OMI-017, OMI-022, OMI-029 | Reviewer độc lập, head/base validation, checks bắt buộc, merge queue, remote confirmation, Done; native approval không bị giả lập |
| OMI-024 | GitHub outbox & reconciliation — Developer — P0 | OMI-006, OMI-010 | Retry/backoff/pagination, operation marker, timeout-after-success test; GitHub offline giữ local state và sync lại không trùng |

### EP-05 — Orchestration & recovery

| ID | Issue / role / priority | Phụ thuộc | Bàn giao và acceptance criteria |
|---|---|---|---|
| OMI-025 | DAG scheduler/parallelism — Developer — P0 | OMI-017, OMI-020, OMI-010 | Ready-only dispatch, scope/priority, limits, blocked propagation; hai task độc lập chạy song song; không hai writer cùng worktree |
| OMI-026 | Business checkpoint — Developer — P0 | OMI-012, OMI-010, OMI-017 | Manifest có counters/versions/Git/uncommitted state; checkpoint tại boundary; interrupted snapshot được đánh dấu; test file/DB crash boundary |
| OMI-027 | Resume/recovery engine — Developer — P0 | OMI-026, OMI-024, OMI-016 | Reconcile process/Git/GitHub rồi resume; missing/hash mismatch được báo; không repeat merge/PR hoặc step đã hợp lệ |
| OMI-028 | Architect escalation 2+2 — Developer — P0 | OMI-008, OMI-025, OMI-026 | Hai quality failures gọi Architect, thêm hai lần rồi blocked; lỗi hạ tầng không tiêu hao counter; task độc lập tiếp tục |
| OMI-029 | Approval lifecycle — Developer — P0 | OMI-008, OMI-011, OMI-006 | Subject hash/actor/source, approve/reject/stale; business/cost trước thực thi; agent JSON không tự tạo approval; CLI/GitHub pathways |
| OMI-030 | Coordinator bridge & vertical slice — Developer — P0 | OMI-018, OMI-023, OMI-025, OMI-028, OMI-029 | Bridge Claude Code gọi CLI; minimal fixture workflow xử lý Issue đến Done; pause/new session/manual coordinator-profile switch; không yêu cầu full library templates M4 |

### EP-06 — Roles, skills & workflows

| ID | Issue / role / priority | Phụ thuộc | Bàn giao và acceptance criteria |
|---|---|---|---|
| OMI-031 | Curate bốn nguồn skills — Architect/Designer — P1 | OMI-007 | Chọn lọc Superpowers/Taste/Ponytail/UI UX Pro Max; ghi source commit/license/attribution; loại xung đột điều phối; không copy nguyên bộ thiếu review |
| OMI-032 | Role/rule templates & resolver — Architect — P1 | OMI-031, OMI-012 | Role không khóa tool/model; skill/rule resolution deterministic; versions/hashes; validate unknown reference và mandatory gate |
| OMI-033 | Onboarding new/existing workflow — Architect/DevOps — P1 | OMI-019, OMI-032 | Detect codebase, sinh config/plan, bảo toàn file hiện hữu; dry-run và fixtures repo mới/cũ |
| OMI-034 | Idea → requirements → Issue workflow — BA/Architect — P1 | OMI-020, OMI-029, OMI-032 | Phạm vi/AC/baseline duyệt, decomposition có dependency; không sinh step thành Issue máy móc; ngoài scope chờ PO |
| OMI-035 | Feature/bugfix/refactor/docs workflows — Developer/QA — P1 | OMI-023, OMI-028, OMI-032 | Các template chạy bằng cùng engine, role/review/gate rõ; bug có regression, refactor giữ hành vi, docs có nghiệm thu |
| OMI-036 | UI/UX và CI/CD workflows — Designer/DevOps — P1 | OMI-029, OMI-032 | Design/visual evidence và pipeline output phù hợp; project không có UI được skip có lý do; chi phí mới cần PO |

### EP-07 — Release & deployment

| ID | Issue / role / priority | Phụ thuộc | Bàn giao và acceptance criteria |
|---|---|---|---|
| OMI-037 | Release planning & PR — Release Manager — P1 | OMI-022, OMI-035 | Release Issue, danh sách task, PR develop→main; giữ đúng branch flow; không tự merge main |
| OMI-038 | Release PO approval gate — Developer — P0 | OMI-029, OMI-037 | Xác minh PO/revision, checks; head đổi làm approval stale; test repo native review restrictions; chặn nếu thiếu quyền cần thiết |
| OMI-039 | Tag/changelog/GitHub Release — DevOps — P1 | OMI-038, OMI-024 | Sau merge main mới tạo artifact release; tags/notes đúng commit; retry không tạo release trùng |
| OMI-040 | Production deployment approval — Developer — P0 | OMI-029, OMI-039 | Approval riêng gắn digest/environment; release approval không đủ; thay artifact yêu cầu quyết định mới |
| OMI-041 | Deploy adapter & verification — DevOps/QA — P1 | OMI-040, OMI-036 | Một pipeline sandbox tham chiếu artifact bất biến; dispatch idempotent, kết quả verify, fail báo PO; rollback chỉ theo runbook duyệt |
| OMI-042 | Full lifecycle acceptance scenario — QA — P1 | OMI-030, OMI-033, OMI-034, OMI-035, OMI-036, OMI-041 | Chạy ý tưởng→task→develop→release→deploy sandbox; evidence đủ, hai approval riêng; PO duyệt thực tế ở gate cần thiết |

### EP-08 — Reliability & packaging

| ID | Issue / role / priority | Phụ thuộc | Bàn giao và acceptance criteria |
|---|---|---|---|
| OMI-043 | Complete architecture/quality CI — Developer — P0 | OMI-001, OMI-007, OMI-032 | Guard đầy đủ layer/root/naming/cycles/schema drift; fixtures vi phạm phải fail; không có wildcard exemption; review required checks |
| OMI-044 | Fault injection/regression suite — QA — P0 | OMI-018, OMI-023, OMI-027, OMI-028, OMI-040 | Ma trận crash/timeout/stale/limits/cancel; xác minh no duplicate/no lost approval/no concurrent writer; tests không phụ thuộc real quota |
| OMI-045 | Packaging/install/update — Developer — P1 | OMI-033, OMI-043, OMI-027 | npm pack sạch, project-local install, preserve overrides, config/state migration+backup; clean WSL2 install không dùng global framework |
| OMI-046 | Operations/Claude Code handbook — Technical Writer — P1 | OMI-030, OMI-041, OMI-045 | Hướng dẫn init/login/run/pause/resume/retry/update/recovery; compatibility matrix, known limitations, folder rules; đối chiếu CLI thật |
| OMI-047 | Beta acceptance trên project thử — QA/PO — P1 | OMI-042, OMI-044, OMI-045, OMI-046 | Một repo mới và một repo có sẵn, log đã khử secret, checklist v0.1; mọi blocker có Issue và quyết định rõ |
| OMI-048 | Release omi-squad v0.1 — Release Manager/PO — P1 | OMI-047 | Issue release framework, PR develop→main được PO duyệt, package/tag/changelog và known limitations; không tự publish dịch vụ mất phí |

## 5. Trình tự và lane song song

Sau OMI-001, chạy PoC Claude/Codex/GitHub độc lập; PoC lifecycle và multi-profile chờ các PoC CLI. Trong M1, schemas/domain và persistence có thể phân công riêng sau contract chung.

Sau core, có thể chạy lane executor adapters, lane Git/GitHub và lane approval/CLI. Worktree manager OMI-021 và outbox OMI-024 cần được kéo sớm vì là dependency của runtime delivery/recovery. Skills curation OMI-031 có thể chạy song song khi contract đủ ổn định.

Một đường găng tham khảo: OMI-001 → OMI-002/003 → OMI-004/005 → core → adapters/supervisor/worktree → dispatch/checkpoint/recovery/failover → merge/Coordinator bridge → lifecycle templates → release/deploy → beta. Đây là hướng tổ chức, bảng dependencies mới là nguồn chính xác.

Không giao song song hai Issue sửa cùng contract lõi nếu chưa thống nhất contract và ownership. Khi conflict, tích hợp trên branch task rồi chạy lại checks; không merge chỉ vì từng branch đã pass riêng.

## 6. Cấu hình GitHub Project đề xuất

### Fields

| Field | Kiểu đề xuất | Giá trị/chú thích |
|---|---|---|
| Status | Single select | Backlog, Ready, In Progress, In Review, Waiting Approval, Waiting Resource, Blocked, Done |
| Priority | Single select | P0, P1, P2 |
| Work Type | Single select hoặc label | Epic, Spike, Task, Bug, Docs, Release |
| Milestone | Native milestone | M0–M5 |
| Workflow | Text hoặc single select | init, research, feature, bugfix, refactor, docs, release, deploy |
| Role | Single select | Architect, Developer, BA, Designer, QA, DevOps, Writer, Release Manager |
| Area | Single select hoặc label | domain, runtime, adapters, github, workflows, delivery, tooling |
| Plan Key | Text | EP-xx hoặc OMI-xxx; immutable logical key |
| Run ID | Text | Run hiện tại, nếu có |
| Blocked Reason | Text | Một câu rõ nguyên nhân |
| Iteration | Iteration, tùy nhu cầu | Không bắt buộc nếu PO giao theo milestone |

Ưu tiên field native khi phù hợp, không tạo trùng với field đã có. Work Type có thể dùng labels để tương thích cấu hình repository; không giả định repo nào cũng có native custom Issue Types. Agent model/profile là dữ liệu biến động trong run, không gán cố định làm assignee GitHub. Assignee là tài khoản người/bot thực, không tên role tưởng tượng.

### Views

| View | Mục đích |
|---|---|
| Delivery Board | Kanban theo Status, loại Epic khỏi board triển khai |
| Backlog | Bảng theo Milestone/Priority, hiển thị dependency và Work Type |
| Epic Breakdown | Nhóm theo parent Epic |
| Needs PO | Waiting Approval và Blocked cần PO |
| Active Runs | In Progress/In Review/Waiting Resource, kèm Run ID |
| Release Readiness | Release Issues và các task thuộc phạm vi release |

Tên field/view là đề xuất ban đầu, có thể mapping khi Project đã tồn tại.

## 7. Issue template và Definition of Ready/Done

Template nội dung mỗi Issue:

```markdown
## Mục tiêu
Một kết quả cụ thể cần đạt.

## Phạm vi
Hành vi cần triển khai và giới hạn của task.

## Acceptance criteria
- [ ] Tiêu chí quan sát/kiểm thử được.
- [ ] Lỗi hoặc trường hợp biên liên quan được xử lý.

## Implementation map
- Domain/use case/adapter liên quan.
- Đường dẫn dự kiến theo architecture.md.

## Dependencies
- Blocked by: <actual issue URLs after import>

## Workflow và review
- Workflow: <template>
- Role chính: <role>
- Required checks/review: <criteria>
- Approval: <none/business/cost/release/deploy as applicable>

## Evidence
- PR, test/report, checkpoint hoặc artifact khi có.

<!-- omi-squad:plan-key=OMI-XXX -->
```

Definition of Ready: objective/AC rõ, dependency đủ, scope đã duyệt, role/workflow có thể chọn, không thiếu quyết định nghiệp vụ/chi phí cần thiết.

Definition of Done với code: AC đạt, checks/review đúng revision, PR link Issue, merge develop xác nhận thật, Project/Issue đồng bộ. Với Spike/Docs: evidence và quyết định được review; nếu có thay đổi trong repo thì PR cũng phải merge. Epic Done khi tất cả con cần thiết và outcome đạt. Release Issue chỉ Done theo release workflow, không áp dụng máy móc “merge develop là xong”.

## 8. Quy trình bootstrap GitHub thực tế

### Bước 1 — Resolve đích và quyền

Xác định owner/repo, default branch, GitHub Project mới hay có sẵn, PO GitHub login và credential được dùng. Kiểm tra quyền API/Project/branch protection trước khi mutate. Nếu chưa có dữ liệu này, đây là tham số cần cung cấp lúc triển khai, không tự đoán từ dự án cũ.

### Bước 2 — Read và preview

Đọc branches, labels, milestones, fields/options, Issues/PR hiện tại. Tạo dry-run manifest: sẽ reuse/create/update đối tượng nào. Không đổi default branch hoặc rewrite branch lịch sử khi chưa có lý do trong kế hoạch.

### Bước 3 — Branches và guardrails

Bảo đảm main/develop tồn tại theo quy trình phù hợp repo; giữ thay đổi hiện tại. Thiết lập CI/gate theo capability thực có. Mọi task PR target develop, mọi release PR target main và cần PO. Tạo Issue/PR templates trước các task triển khai.

### Bước 4 — Labels, milestones, Project fields

Upsert theo mapping đã xác thực, lưu GitHub node IDs và option IDs. Không hardcode số Project hoặc Issue. Tạo các view theo khả năng API/UI có sẵn; nếu API không hỗ trợ view cụ thể thì ghi thao tác UI còn lại, không báo đã tạo.

### Bước 5 — Issues theo hai lượt

Lượt một: tạo/reuse 8 Epic Issues và 48 task Issues, gán Plan Key, milestone, priority và body. Lượt hai: từ map Plan Key→GitHub node ID/number, gắn parent/sub-issue và blocked-by relationships, thêm vào Project và cập nhật field.

Không dùng số thứ tự OMI-001 làm Issue #1. Native sub-issue và dependency là quan hệ khác nhau; gắn cả hai đúng mục đích. Nếu capability thiếu, dùng explicit backlink/checklist có mapping và báo đây là fallback.

### Bước 6 — Verify và chuyển Ready

Đối soát số đối tượng, mapping, cha–con, dependency không vòng, milestone và field. Chỉ chuyển Ready cho Issue đủ DoR; đầu tiên thường OMI-001. PO có thể giao toàn M0, scheduler chọn task theo dependency.

### Bước 7 — Bootstrap bằng Claude Code

Trước khi omi-squad chạy được, Claude Code triển khai thủ công theo chính các tài liệu/Issue này. Dùng fake executors và sandbox fixtures để phát triển runtime. Chỉ dogfood điều phối tự động sau OMI-030; không tạo phụ thuộc vòng “cần framework hoàn chỉnh để xây framework”.

## 9. Manifest khởi tạo đề xuất

Khi implement importer, nguồn machine-readable đặt tại `docs/planning/github-backlog.yaml`; tài liệu này là baseline để sinh manifest rồi review. Chưa có file manifest riêng trong bộ bàn giao này.

```yaml
schema_version: 1
project:
  owner: "<resolve-at-bootstrap>"
  repository: "<resolve-at-bootstrap>"
  project_number: null
issues:
  - key: EP-01
    title: "Bootstrap & feasibility"
    type: epic
    milestone: M0
  - key: OMI-001
    title: "Scaffold clean architecture"
    type: task
    parent: EP-01
    milestone: M0
    priority: P0
    blocked_by: []
    workflow: feature
```

Đây là ví dụ hai entries, không phải manifest đủ 56 Issues. Importer cần dry-run/apply/resume và mapping state local ở `.omi-squad/local/`; có journal và idempotency. Tên công cụ/importer chỉ được thêm vào CLI/tooling theo architecture, không tạo script ngẫu nhiên ở root.

## 10. Ma trận nghiệm thu v0.1

| Test | Tình huống | Chủ sở hữu Issue |
|---|---|---|
| AT-01 | Install repo mới và brownfield không mất cấu hình | OMI-033, OMI-045 |
| AT-02 | Cả Claude Code/Codex subscription chạy step thật | OMI-013, OMI-014 |
| AT-03 | Profile limit, failover, continuation không mất counters | OMI-018 |
| AT-04 | Đóng Coordinator, stop worker; session mới resume | OMI-016, OMI-027, OMI-030 |
| AT-05 | Hai task song song, dependency blocked đúng | OMI-025 |
| AT-06 | Hai failed → Architect → hai failed → stop task | OMI-028 |
| AT-07 | Review stale, wrong actor approval, missing Issue link bị chặn | OMI-023, OMI-029 |
| AT-08 | GitHub timeout sau thành công không tạo PR trùng | OMI-024 |
| AT-09 | Merge develop xác nhận rồi cập nhật Done | OMI-023 |
| AT-10 | Main release phải duyệt; head mới vô hiệu duyệt cũ | OMI-038 |
| AT-11 | Release duyệt chưa cho deploy; deploy cần digest approval riêng | OMI-040, OMI-041 |
| AT-12 | Architecture violations và misplaced files làm CI fail | OMI-043 |
| AT-13 | Artifact package/log/context không có credential | OMI-044, OMI-045 |
| AT-14 | Full lifecycle và tài liệu khớp hành vi thực tế | OMI-042, OMI-046, OMI-047 |

Mỗi AT có evidence pass/fail/blocked và môi trường/versions. Không đổi blocked thành pass bằng lời giải thích. Limit giả lập chứng minh control flow; phát hiện limit thật và auth isolation vẫn cần evidence riêng trong compatibility matrix.

## 11. Rủi ro và xử lý

| Rủi ro | Hành động |
|---|---|
| CLI không isolate profile subscription như kỳ vọng | Block ở M0; báo PO và ADR, không đổi yêu cầu âm thầm |
| Quota/model availability không quan sát đầy đủ | Dùng unknown + configured capability + actual errors, không đoán quota |
| Agent full shell vượt gate local | Minh bạch trust boundary; dùng remote branch/pipeline gates khi có |
| Cùng GitHub identity không native approve được | Tách agent-review evidence khỏi native approval; chờ actor hợp lệ |
| Coordinator exit không hook được tin cậy | Managed supervisor launch, test crash/WSL lifecycle |
| Cấu trúc bị agent làm lệch | Architecture guard ngay OMI-001, hoàn thiện OMI-043 |
| Skills xung đột hoặc kéo thêm phí/tool | Curate, provenance, review, permission/cost gate |
| Kế hoạch quá lớn cho một Issue | Tách thêm sub-issue với outcome độc lập và cập nhật map/dependency |

## 12. Hướng dẫn giao việc cho Claude Code

Đưa năm tài liệu vào các vị trí trong `architecture.md`. Yêu cầu Claude Code đọc overview, architecture, tech-stack và patterns trước khi implement; bootstrap GitHub theo mục 8 rồi chọn task Ready trong scope PO giao. Mỗi task phải có Issue thật trước PR, có implementation map và tests phù hợp. Không tự xây thêm dashboard, đa-repo, API-key routing hoặc daemon cloud.

Không đưa toàn bộ 48 task cho một agent code trong một lần. Dùng task nhỏ, branch/worktree theo quy định, review độc lập và gate release/deploy. Với blocker kỹ thuật, giữ evidence và báo đúng phạm vi còn thiếu.

### Nguồn GitHub tham chiếu

- [Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects).
- [Issue dependencies API](https://docs.github.com/en/rest/issues/issue-dependencies).
- [PR–Issue linking và default branch behavior](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).

API support và quyền cần được kiểm tra lại trên repo/Project thực khi bootstrap; tài liệu không ngầm giả định mọi tính năng của một gói GitHub cụ thể.
