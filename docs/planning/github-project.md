# GitHub Project và mapping backlog

**Bản ghi cấu hình**, không theo dõi tiến độ: trạng thái, assignee và phạm vi hiện hành của task
chỉ xem trên [GitHub Project](https://github.com/orgs/omi-hub-services/projects/1) (AGENTS.md §8).
File này chỉ cập nhật khi cấu hình Project/repo thay đổi.

Kết quả bootstrap ngày 2026-11-10. Nguồn dữ liệu seed: [github-backlog.yaml](github-backlog.yaml)
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
| Items bootstrap    | 56 (8 Epic + 48 sub-issue); Issue thêm sau đó tra theo field Plan Key trên Project             |

## Milestones

Milestone lấy từ project-plan.md §2, không suy từ Epic cha.

| Milestone            | GitHub                                                    |
| -------------------- | --------------------------------------------------------- |
| M0 — Feasibility     | [#1](https://github.com/omi-hub-services/omi/milestone/1) |
| M1 — Core foundation | [#2](https://github.com/omi-hub-services/omi/milestone/2) |
| M2 — Execution       | [#3](https://github.com/omi-hub-services/omi/milestone/3) |
| M3 — Task delivery   | [#4](https://github.com/omi-hub-services/omi/milestone/4) |
| M4 — Full lifecycle  | [#5](https://github.com/omi-hub-services/omi/milestone/5) |
| M5 — v0.1 acceptance | [#6](https://github.com/omi-hub-services/omi/milestone/6) |

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

- **Parent/sub-issue:** native sub-issues (mỗi task đúng một Epic).
- **Dependencies:** native issue dependencies (blocked by); lúc bootstrap khớp đúng `blocked_by`
  trong manifest và không có vòng. Dependency hiện hành xem trên GitHub.
- Body mỗi Issue có mục tiêu, phạm vi, acceptance criteria, implementation map, dependency URL
  thật, workflow/role/checks/approval theo template project-plan.md §7.

## Mapping Plan key → Issue (bootstrap)

Chỉ là ánh xạ khóa kế hoạch sang số Issue; milestone, priority, dependency và trạng thái hiện
hành xem trên GitHub Project.

| Plan key | Issue | Title |
| -------- | ----- | ----- |
| **EP-01** | [#1](https://github.com/omi-hub-services/omi/issues/1) | **Bootstrap & feasibility** |
| OMI-001 | [#2](https://github.com/omi-hub-services/omi/issues/2) | Scaffold clean architecture |
| OMI-002 | [#3](https://github.com/omi-hub-services/omi/issues/3) | PoC Claude Code subscription worker |
| OMI-003 | [#4](https://github.com/omi-hub-services/omi/issues/4) | PoC Codex subscription worker |
| OMI-004 | [#5](https://github.com/omi-hub-services/omi/issues/5) | PoC nhiều profile và continuation |
| OMI-005 | [#6](https://github.com/omi-hub-services/omi/issues/6) | PoC lifecycle WSL2 |
| OMI-006 | [#7](https://github.com/omi-hub-services/omi/issues/7) | PoC GitHub capability |
| **EP-02** | [#8](https://github.com/omi-hub-services/omi/issues/8) | **Domain & persistent state** |
| OMI-007 | [#9](https://github.com/omi-hub-services/omi/issues/9) | Contract/schema v1 |
| OMI-008 | [#10](https://github.com/omi-hub-services/omi/issues/10) | Domain policies/state machines |
| OMI-009 | [#11](https://github.com/omi-hub-services/omi/issues/11) | SQLite schema/migration |
| OMI-010 | [#12](https://github.com/omi-hub-services/omi/issues/12) | Transaction, leases và audit |
| OMI-011 | [#13](https://github.com/omi-hub-services/omi/issues/13) | CLI/IPC skeleton |
| OMI-012 | [#14](https://github.com/omi-hub-services/omi/issues/14) | Artifact store & context packet |
| **EP-03** | [#15](https://github.com/omi-hub-services/omi/issues/15) | **Agent execution & profiles** |
| OMI-013 | [#16](https://github.com/omi-hub-services/omi/issues/16) | Production Claude adapter |
| OMI-014 | [#17](https://github.com/omi-hub-services/omi/issues/17) | Production Codex adapter |
| OMI-015 | [#18](https://github.com/omi-hub-services/omi/issues/18) | Profile registry & selector |
| OMI-016 | [#19](https://github.com/omi-hub-services/omi/issues/19) | Session supervisor/runtime |
| OMI-017 | [#20](https://github.com/omi-hub-services/omi/issues/20) | Dispatch và validate result |
| OMI-018 | [#21](https://github.com/omi-hub-services/omi/issues/21) | Failover từ checkpoint |
| **EP-04** | [#22](https://github.com/omi-hub-services/omi/issues/22) | **GitHub & Git delivery** |
| OMI-019 | [#23](https://github.com/omi-hub-services/omi/issues/23) | Init và GitHub Project mapping |
| OMI-020 | [#24](https://github.com/omi-hub-services/omi/issues/24) | Import task/scope/dependencies |
| OMI-021 | [#25](https://github.com/omi-hub-services/omi/issues/25) | Git branch/worktree manager |
| OMI-022 | [#26](https://github.com/omi-hub-services/omi/issues/26) | PR creation & Issue linkage |
| OMI-023 | [#27](https://github.com/omi-hub-services/omi/issues/27) | Review/check gates & merge |
| OMI-024 | [#28](https://github.com/omi-hub-services/omi/issues/28) | GitHub outbox & reconciliation |
| **EP-05** | [#29](https://github.com/omi-hub-services/omi/issues/29) | **Orchestration & recovery** |
| OMI-025 | [#30](https://github.com/omi-hub-services/omi/issues/30) | DAG scheduler/parallelism |
| OMI-026 | [#31](https://github.com/omi-hub-services/omi/issues/31) | Business checkpoint |
| OMI-027 | [#32](https://github.com/omi-hub-services/omi/issues/32) | Resume/recovery engine |
| OMI-028 | [#33](https://github.com/omi-hub-services/omi/issues/33) | Architect escalation 2+2 |
| OMI-029 | [#34](https://github.com/omi-hub-services/omi/issues/34) | Approval lifecycle |
| OMI-030 | [#35](https://github.com/omi-hub-services/omi/issues/35) | Coordinator bridge & vertical slice |
| **EP-06** | [#36](https://github.com/omi-hub-services/omi/issues/36) | **Roles, skills & workflows** |
| OMI-031 | [#37](https://github.com/omi-hub-services/omi/issues/37) | Curate bốn nguồn skills |
| OMI-032 | [#38](https://github.com/omi-hub-services/omi/issues/38) | Role/rule templates & resolver |
| OMI-033 | [#39](https://github.com/omi-hub-services/omi/issues/39) | Onboarding new/existing workflow |
| OMI-034 | [#40](https://github.com/omi-hub-services/omi/issues/40) | Idea → requirements → Issue workflow |
| OMI-035 | [#41](https://github.com/omi-hub-services/omi/issues/41) | Feature/bugfix/refactor/docs workflows |
| OMI-036 | [#42](https://github.com/omi-hub-services/omi/issues/42) | UI/UX và CI/CD workflows |
| **EP-07** | [#43](https://github.com/omi-hub-services/omi/issues/43) | **Release & deployment** |
| OMI-037 | [#44](https://github.com/omi-hub-services/omi/issues/44) | Release planning & PR |
| OMI-038 | [#45](https://github.com/omi-hub-services/omi/issues/45) | Release PO approval gate |
| OMI-039 | [#46](https://github.com/omi-hub-services/omi/issues/46) | Tag/changelog/GitHub Release |
| OMI-040 | [#47](https://github.com/omi-hub-services/omi/issues/47) | Production deployment approval |
| OMI-041 | [#48](https://github.com/omi-hub-services/omi/issues/48) | Deploy adapter & verification |
| OMI-042 | [#49](https://github.com/omi-hub-services/omi/issues/49) | Full lifecycle acceptance scenario |
| **EP-08** | [#50](https://github.com/omi-hub-services/omi/issues/50) | **Reliability & packaging** |
| OMI-043 | [#51](https://github.com/omi-hub-services/omi/issues/51) | Complete architecture/quality CI |
| OMI-044 | [#52](https://github.com/omi-hub-services/omi/issues/52) | Fault injection/regression suite |
| OMI-045 | [#53](https://github.com/omi-hub-services/omi/issues/53) | Packaging/install/update |
| OMI-046 | [#54](https://github.com/omi-hub-services/omi/issues/54) | Operations/Claude Code handbook |
| OMI-047 | [#55](https://github.com/omi-hub-services/omi/issues/55) | Beta acceptance trên project thử |
| OMI-048 | [#56](https://github.com/omi-hub-services/omi/issues/56) | Release omi-squad v0.1 |

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

### Cấu hình làm trên UI (API không hỗ trợ), áp dụng 2026-11-10

API chỉ nhận name/layout/filter/visible fields; phần dưới được làm trên UI và đọc lại qua API:

- **Delivery Board:** cột theo Status.
- **Backlog:** Group by **Milestone**, Sort by **Priority** tăng dần, **Show hierarchy tắt** (để
  task nằm đúng milestone của nó, không lồng dưới Epic có milestone khác).
- **Epic Breakdown:** Group by **Parent issue**.
- **Release Readiness:** khi có release, thêm milestone release vào filter.
- Project không có field dependency: dependency xem ở trang Issue (mục Relationships).
- Built-in workflows: chỉ **Auto-add sub-issues to project** bật; các workflow tự đặt Done đều
  tắt vì Done phải theo merge vào `develop` đã xác nhận.

## Branch protection (rulesets, bật 2026-11-10)

Không có bypass actor, áp dụng cả admin.

| Ruleset                                  | Nhánh     | Rules                                                                                                     |
| ---------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| `develop: PR + CI gates` (id 26922271)     | `develop` | PR bắt buộc; checks `check`, `issue-link` (strict, nhánh phải cập nhật); cấm force-push/xóa; 0 approval     |
| `main: PR + CI + PO approval` (id 26922272) | `main`    | Như trên + 1 approval, approval cũ mất hiệu lực khi có commit mới, người push cuối không tự approve được |

Task PR vào `develop` merge sau review độc lập (agent) và CI. Release PR vào `main` cần PO
approve native.

## Repository settings

| Setting                  | Giá trị | Bật        | Ghi chú                                                                                   |
| ------------------------ | ------- | ---------- | ----------------------------------------------------------------------------------------- |
| `delete_branch_on_merge` | `true`  | 2026-11-10 | GitHub tự xóa nhánh remote sau merge; nhánh local dọn bằng `tools/coordinator/flow.ts cleanup` |

Required checks (`check`, `issue-link`) và option ID của field được script Coordinator đọc trực
tiếp từ GitHub, không sao chép thêm ở đây.

## Tài khoản GitHub

| Tài khoản             | Vai trò                                                     | Quyền                  |
| --------------------- | ----------------------------------------------------------- | ---------------------- |
| `ttin-omihub`         | PO; approver release PR vào `main`; `gh` trong WSL2         | org admin, repo admin  |
| `minibox-claude-code` | Agent/Coordinator trên Windows (ADR-0012); tác giả PR      | org member, repo admin |

Release PR phải do tài khoản khác PO tạo để PO approve được.

## Branch/PR bootstrap

- Seed commit `05a74cf` trên `main`: **ngoại lệ bootstrap một lần** vì remote rỗng; `develop`
  tạo từ đó.
- Scaffold OMI-001 vào `develop` qua PR [#57](https://github.com/omi-hub-services/omi/pull/57)
  (merge commit `b31eb82`), sau review độc lập.

## Giới hạn

- `tools/github-bootstrap` là công cụ một lần. **Không chạy lại `apply`**: nó đưa title/body
  Issue về nội dung seed và sẽ ghi đè các chỉnh sửa đã làm trên GitHub sau bootstrap.

## Workflow routing (OMI-093)

The Workflow field options above are preserved. `init` resolves to `onboarding-takeover` for an
existing repository, and `research` to `idea-to-issues`; a new empty project explicitly selects
`onboarding-empty-repo`. Canonical workflow ids (including `ui-ux` and `ci-cd`) resolve directly
when configured on a Project. `release` and `deploy` route to the existing `prepare-release` and
`deploy-release` delivery use cases, retaining their distinct recorded PO approvals; they are not
worker-template aliases. `flow.ts workflow-options` checks the live field against these routes and
the configured checkout's template files; the unit suite checks this document's option row.
