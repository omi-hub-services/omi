# GitHub Project và mapping backlog

Kết quả bootstrap ngày 2026-11-10. Nguồn dữ liệu: [github-backlog.yaml](github-backlog.yaml)
(cross-check tự động với [project-plan.md](project-plan.md)). Công cụ áp dụng:
`tools/github-bootstrap/main.ts` (`validate` | `plan` | `apply`), idempotent theo marker
`<!-- omi-squad:plan-key=KEY -->` trong body Issue. Journal và mapping ID đầy đủ (kể cả node ID)
nằm ở `.tmp/github-bootstrap/` (gitignored, không chứa token).

## Repository và Project

| Đối tượng          | Giá trị                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Repository         | [omi-hub-services/omi](https://github.com/omi-hub-services/omi) (public, default `main`)       |
| Branches           | `main` (release), `develop` (integration) — cùng seed commit `05a74cf`                         |
| GitHub Project     | [omi-squad delivery — #1](https://github.com/orgs/omi-hub-services/projects/1) (org, private) |
| Project node ID    | `PVT_kwDOFSS4LM4Bq8Hl`; repository đã được liên kết vào Project                                 |
| Items              | 56 (8 Epic + 48 sub-issue), Status khởi tạo `Backlog`                                          |

## Milestones

Milestone lấy từ project-plan.md §2, không suy từ Epic cha. Số Issue mở gồm cả Epic.

| Milestone | GitHub | Issues |
| --------- | ------ | ------ |
| M0 — Feasibility | [#1](https://github.com/omi-hub-services/omi/milestone/1) | 7 |
| M1 — Core foundation | [#2](https://github.com/omi-hub-services/omi/milestone/2) | 7 |
| M2 — Execution | [#3](https://github.com/omi-hub-services/omi/milestone/3) | 11 |
| M3 — Task delivery | [#4](https://github.com/omi-hub-services/omi/milestone/4) | 8 |
| M4 — Full lifecycle | [#5](https://github.com/omi-hub-services/omi/milestone/5) | 14 |
| M5 — v0.1 acceptance | [#6](https://github.com/omi-hub-services/omi/milestone/6) | 7 |

EP-04 và EP-05 trải M2–M3 nên không gán một native milestone; từng sub-issue mang milestone
riêng. OMI-021, OMI-024, OMI-026, OMI-027 được kéo vào M2 đúng kế hoạch.

## Field mapping

Native field dùng lại: **Status** (options thay theo plan), **Milestone**, **Assignees**,
**Parent issue**, **Sub-issues progress**, **Linked pull requests**. Không tạo field trùng.
Work Type dùng Project field, không dùng labels hay native Issue Types (org chưa có các type
Epic/Spike/Docs/Release và tài khoản bootstrap không phải org admin). Iteration không tạo vì
PO giao việc theo milestone. Assignee chỉ là tài khoản GitHub thật; role nằm ở field Role.

| Field | ID | Options |
| ----- | -- | ------- |
| Status | `PVTSSF_lADOFSS4LM4Bq8HlzhpQ_l8` | Backlog, Ready, In Progress, In Review, Waiting Approval, Waiting Resource, Blocked, Done |
| Priority | `PVTSSF_lADOFSS4LM4Bq8HlzhpQ_oc` | P0, P1, P2 |
| Work Type | `PVTSSF_lADOFSS4LM4Bq8HlzhpQ_og` | Epic, Spike, Task, Bug, Docs, Release |
| Workflow | `PVTSSF_lADOFSS4LM4Bq8HlzhpQ_pc` | init, research, feature, bugfix, refactor, docs, release, deploy |
| Role | `PVTSSF_lADOFSS4LM4Bq8HlzhpQ_pg` | Architect, Developer, BA, Designer, QA, DevOps, Writer, Release Manager |
| Area | `PVTSSF_lADOFSS4LM4Bq8HlzhpQ_ps` | domain, runtime, adapters, github, workflows, delivery, tooling |
| Plan Key | `PVTF_lADOFSS4LM4Bq8HlzhpQ_p4` | text |
| Run ID | `PVTF_lADOFSS4LM4Bq8HlzhpQ_q8` | text |
| Blocked Reason | `PVTF_lADOFSS4LM4Bq8HlzhpQ_rs` | text |

## Quan hệ Issue

- **Parent/sub-issue:** native sub-issues, 48 cạnh (mỗi task đúng một Epic).
- **Dependencies:** native issue dependencies (blocked by), 118 cạnh, đúng bằng tổng
  `blocked_by` trong manifest; đã kiểm tra lại từ remote là không có vòng.
- Body mỗi Issue có mục tiêu, phạm vi, acceptance criteria, implementation map, dependency URL
  thật, workflow/role/checks/approval theo template project-plan.md §7.

## Epic và Issue

| Plan key | Issue | Title | Work Type | Milestone | Priority | Blocked by |
| -------- | ----- | ----- | --------- | --------- | -------- | ---------- |
| **EP-01** | [#1](https://github.com/omi-hub-services/omi/issues/1) | **Bootstrap & feasibility** | Epic | M0 | — | — |
| OMI-001 | [#2](https://github.com/omi-hub-services/omi/issues/2) | Scaffold clean architecture | Task | M0 | P0 | — |
| OMI-002 | [#3](https://github.com/omi-hub-services/omi/issues/3) | PoC Claude Code subscription worker | Spike | M0 | P0 | #2 |
| OMI-003 | [#4](https://github.com/omi-hub-services/omi/issues/4) | PoC Codex subscription worker | Spike | M0 | P0 | #2 |
| OMI-004 | [#5](https://github.com/omi-hub-services/omi/issues/5) | PoC nhiều profile và continuation | Spike | M0 | P0 | #3, #4 |
| OMI-005 | [#6](https://github.com/omi-hub-services/omi/issues/6) | PoC lifecycle WSL2 | Spike | M0 | P0 | #3, #4 |
| OMI-006 | [#7](https://github.com/omi-hub-services/omi/issues/7) | PoC GitHub capability | Spike | M0 | P0 | #2 |
| **EP-02** | [#8](https://github.com/omi-hub-services/omi/issues/8) | **Domain & persistent state** | Epic | M1 | — | — |
| OMI-007 | [#9](https://github.com/omi-hub-services/omi/issues/9) | Contract/schema v1 | Task | M1 | P0 | #2 |
| OMI-008 | [#10](https://github.com/omi-hub-services/omi/issues/10) | Domain policies/state machines | Task | M1 | P0 | #9 |
| OMI-009 | [#11](https://github.com/omi-hub-services/omi/issues/11) | SQLite schema/migration | Task | M1 | P0 | #9 |
| OMI-010 | [#12](https://github.com/omi-hub-services/omi/issues/12) | Transaction, leases và audit | Task | M1 | P0 | #10, #11 |
| OMI-011 | [#13](https://github.com/omi-hub-services/omi/issues/13) | CLI/IPC skeleton | Task | M1 | P0 | #9, #11 |
| OMI-012 | [#14](https://github.com/omi-hub-services/omi/issues/14) | Artifact store & context packet | Task | M1 | P0 | #9, #11 |
| **EP-03** | [#15](https://github.com/omi-hub-services/omi/issues/15) | **Agent execution & profiles** | Epic | M2 | — | — |
| OMI-013 | [#16](https://github.com/omi-hub-services/omi/issues/16) | Production Claude adapter | Task | M2 | P0 | #3, #9, #14 |
| OMI-014 | [#17](https://github.com/omi-hub-services/omi/issues/17) | Production Codex adapter | Task | M2 | P0 | #4, #9, #14 |
| OMI-015 | [#18](https://github.com/omi-hub-services/omi/issues/18) | Profile registry & selector | Task | M2 | P0 | #5, #10, #11 |
| OMI-016 | [#19](https://github.com/omi-hub-services/omi/issues/19) | Session supervisor/runtime | Task | M2 | P0 | #6, #12, #13 |
| OMI-017 | [#20](https://github.com/omi-hub-services/omi/issues/20) | Dispatch và validate result | Task | M2 | P0 | #16, #17, #19, #25 |
| OMI-018 | [#21](https://github.com/omi-hub-services/omi/issues/21) | Failover từ checkpoint | Task | M2 | P0 | #18, #20, #32 |
| **EP-04** | [#22](https://github.com/omi-hub-services/omi/issues/22) | **GitHub & Git delivery** | Epic | M2–M3 (không gán) | — | — |
| OMI-019 | [#23](https://github.com/omi-hub-services/omi/issues/23) | Init và GitHub Project mapping | Task | M3 | P1 | #7, #9, #13 |
| OMI-020 | [#24](https://github.com/omi-hub-services/omi/issues/24) | Import task/scope/dependencies | Task | M3 | P0 | #23, #11 |
| OMI-021 | [#25](https://github.com/omi-hub-services/omi/issues/25) | Git branch/worktree manager | Task | M2 | P0 | #2, #12 |
| OMI-022 | [#26](https://github.com/omi-hub-services/omi/issues/26) | PR creation & Issue linkage | Task | M3 | P1 | #24, #25, #28 |
| OMI-023 | [#27](https://github.com/omi-hub-services/omi/issues/27) | Review/check gates & merge | Task | M3 | P0 | #20, #26, #34 |
| OMI-024 | [#28](https://github.com/omi-hub-services/omi/issues/28) | GitHub outbox & reconciliation | Task | M2 | P0 | #7, #12 |
| **EP-05** | [#29](https://github.com/omi-hub-services/omi/issues/29) | **Orchestration & recovery** | Epic | M2–M3 (không gán) | — | — |
| OMI-025 | [#30](https://github.com/omi-hub-services/omi/issues/30) | DAG scheduler/parallelism | Task | M3 | P0 | #20, #24, #12 |
| OMI-026 | [#31](https://github.com/omi-hub-services/omi/issues/31) | Business checkpoint | Task | M2 | P0 | #14, #12, #20 |
| OMI-027 | [#32](https://github.com/omi-hub-services/omi/issues/32) | Resume/recovery engine | Task | M2 | P0 | #31, #28, #19 |
| OMI-028 | [#33](https://github.com/omi-hub-services/omi/issues/33) | Architect escalation 2+2 | Task | M3 | P0 | #10, #30, #31 |
| OMI-029 | [#34](https://github.com/omi-hub-services/omi/issues/34) | Approval lifecycle | Task | M3 | P0 | #10, #13, #7 |
| OMI-030 | [#35](https://github.com/omi-hub-services/omi/issues/35) | Coordinator bridge & vertical slice | Task | M3 | P0 | #21, #27, #30, #33, #34 |
| **EP-06** | [#36](https://github.com/omi-hub-services/omi/issues/36) | **Roles, skills & workflows** | Epic | M4 | — | — |
| OMI-031 | [#37](https://github.com/omi-hub-services/omi/issues/37) | Curate bốn nguồn skills | Task | M4 | P1 | #9 |
| OMI-032 | [#38](https://github.com/omi-hub-services/omi/issues/38) | Role/rule templates & resolver | Task | M4 | P1 | #37, #14 |
| OMI-033 | [#39](https://github.com/omi-hub-services/omi/issues/39) | Onboarding new/existing workflow | Task | M4 | P1 | #23, #38 |
| OMI-034 | [#40](https://github.com/omi-hub-services/omi/issues/40) | Idea → requirements → Issue workflow | Task | M4 | P1 | #24, #34, #38 |
| OMI-035 | [#41](https://github.com/omi-hub-services/omi/issues/41) | Feature/bugfix/refactor/docs workflows | Task | M4 | P1 | #27, #33, #38 |
| OMI-036 | [#42](https://github.com/omi-hub-services/omi/issues/42) | UI/UX và CI/CD workflows | Task | M4 | P1 | #34, #38 |
| **EP-07** | [#43](https://github.com/omi-hub-services/omi/issues/43) | **Release & deployment** | Epic | M4 | — | — |
| OMI-037 | [#44](https://github.com/omi-hub-services/omi/issues/44) | Release planning & PR | Task | M4 | P1 | #26, #41 |
| OMI-038 | [#45](https://github.com/omi-hub-services/omi/issues/45) | Release PO approval gate | Task | M4 | P0 | #34, #44 |
| OMI-039 | [#46](https://github.com/omi-hub-services/omi/issues/46) | Tag/changelog/GitHub Release | Task | M4 | P1 | #45, #28 |
| OMI-040 | [#47](https://github.com/omi-hub-services/omi/issues/47) | Production deployment approval | Task | M4 | P0 | #34, #46 |
| OMI-041 | [#48](https://github.com/omi-hub-services/omi/issues/48) | Deploy adapter & verification | Task | M4 | P1 | #47, #42 |
| OMI-042 | [#49](https://github.com/omi-hub-services/omi/issues/49) | Full lifecycle acceptance scenario | Task | M4 | P1 | #35, #39, #40, #41, #42, #48 |
| **EP-08** | [#50](https://github.com/omi-hub-services/omi/issues/50) | **Reliability & packaging** | Epic | M5 | — | — |
| OMI-043 | [#51](https://github.com/omi-hub-services/omi/issues/51) | Complete architecture/quality CI | Task | M5 | P0 | #2, #9, #38 |
| OMI-044 | [#52](https://github.com/omi-hub-services/omi/issues/52) | Fault injection/regression suite | Task | M5 | P0 | #21, #27, #32, #33, #47 |
| OMI-045 | [#53](https://github.com/omi-hub-services/omi/issues/53) | Packaging/install/update | Task | M5 | P1 | #39, #51, #32 |
| OMI-046 | [#54](https://github.com/omi-hub-services/omi/issues/54) | Operations/Claude Code handbook | Docs | M5 | P1 | #35, #48, #53 |
| OMI-047 | [#55](https://github.com/omi-hub-services/omi/issues/55) | Beta acceptance trên project thử | Task | M5 | P1 | #49, #52, #53, #54 |
| OMI-048 | [#56](https://github.com/omi-hub-services/omi/issues/56) | Release omi-squad v0.1 | Release | M5 | P1 | #55 |

## Views

Tạo bằng GraphQL `createProjectV2View`/`updateProjectV2View` (layout, filter, visible fields).

| View              | Layout | Filter                                                  |
| ----------------- | ------ | ------------------------------------------------------- |
| Delivery Board    | Board  | `-work-type:Epic`                                       |
| Backlog           | Table  | `-status:Done`                                          |
| Epic Breakdown    | Table  | `-work-type:Epic`                                       |
| Needs PO          | Table  | `status:"Waiting Approval",Blocked`                     |
| Active Runs       | Table  | `status:"In Progress","In Review","Waiting Resource"`   |
| Release Readiness | Table  | `work-type:Release`                                     |

### Bước UI còn thiếu (API không hỗ trợ)

API chỉ nhận name/layout/filter/visible fields; group-by, sort và cột board phải làm trên UI:

1. **Delivery Board:** kiểm tra cột = Status (board mặc định nhóm theo field single-select đầu
   tiên); sắp thứ tự cột theo Backlog → Done nếu khác.
2. **Backlog:** Group by **Milestone**, Sort by **Priority** tăng dần.
3. **Epic Breakdown:** Group by **Parent issue**.
4. **Release Readiness:** khi có release, thêm milestone release vào filter
   (ví dụ `work-type:Release,Task milestone:"M5 — v0.1 acceptance"`).
5. Mở từng view, xác nhận filter hiển thị đúng item (filter đã đặt qua API nhưng kết quả lọc
   chỉ xem được trên UI), rồi **Save**.
6. Project không có field dependency: "hiển thị dependency" của Backlog xem qua trang Issue
   (mục Relationships) hoặc body Issue.
7. Built-in workflows (kiểm tra qua API 2026-11-10): chỉ **Auto-add sub-issues to project**
   đang bật; Item closed, Pull request merged, Pull request linked, Item added, Auto-close
   đều tắt. Giữ tắt các workflow đặt Done tự động: Done phải theo merge vào `develop` đã xác
   nhận, và PR vào `develop` không đóng Issue bằng closing keyword.

## Branch/PR bootstrap

- Seed commit `05a74cf` trên `main`: **ngoại lệ bootstrap một lần** vì remote rỗng; `develop`
  tạo từ đó. Không commit trực tiếp nào khác vào `main`/`develop`.
- Scaffold đi qua task branch `task/omi-001-scaffold` → PR vào `develop`:
  [#57](https://github.com/omi-hub-services/omi/pull/57), body `Issue: #2`, backlink comment
  trên [#2](https://github.com/omi-hub-services/omi/issues/2). OMI-001 đang **In Review**,
  assignee `minibox-claude-code`; chưa merge.

## Giới hạn và việc còn lại

- Chưa có branch protection/ruleset cho `main`/`develop` (không bắt buộc trong bootstrap; cần
  quyết định reviewer hợp lệ trước khi bật required review).
- Reviewer độc lập: tài khoản bootstrap `minibox-claude-code` là tác giả PR nên không thể là
  reviewer native của chính PR đó.
