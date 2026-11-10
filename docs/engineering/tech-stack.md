# omi-squad — Tech Stack và chuẩn triển khai

Phiên bản 1.0 · 10/11/2026. Đọc cùng `architecture.md`. Đây là baseline đề xuất cho việc implement, không phải bộ dependency đã cài hoặc test tương thích.

## 1. Nguyên tắc chọn công nghệ

Ưu tiên ít thành phần, chạy local trong WSL2, dễ kiểm thử process và checkpoint. Chọn thư viện cho nhu cầu cụ thể, giữ dependency ở đúng layer và pin phiên bản sau compatibility spike. Không dùng API tính phí làm fallback ngầm cho subscription; không chọn framework web chỉ để xây CLI.

## 2. Stack đề xuất

| Hạng mục | Lựa chọn | Lý do và vị trí |
|---|---|---|
| OS | Ubuntu trong WSL2 | Môi trường Linux thống nhất cho Coordinator và worker |
| Runtime | Node.js 24 LTS baseline | Dòng LTS; pin patch đã kiểm thử. Node 26 LTS là ứng viên nâng cấp sau compatibility test |
| Ngôn ngữ | TypeScript, strict, ESM | Contract typed; domain thuần; build bằng `tsc` |
| Package manager | npm + `package-lock.json` | Một lockfile, `npm ci`, không cần workspace monorepo tool |
| CLI | Commander | Parse args/help/subcommands trong interfaces |
| Contract validation | Zod 4 | Schema và type suy ra; sinh JSON Schema cho agent |
| Config | YAML qua package `yaml` | Dễ đọc workflow/role, validate ngay sau parse |
| Persistence | SQLite qua `better-sqlite3` | Transaction local, driver nằm trong infrastructure |
| Migration | SQL thuần + runner nhỏ | Version rõ, không ORM cho state schema nhỏ |
| Process | `node:child_process.spawn` | Argv array, stream, cancellation, process lifecycle |
| IPC | `node:net`, Unix domain socket | Chỉ local, không mở HTTP public |
| Files/hash | `node:fs/promises`, `node:crypto` | Atomic writes, checksums và manifests |
| Git | Git CLI qua process adapter | Worktree/branch/revision bằng công cụ chuẩn |
| GitHub | `gh` + REST/GraphQL | Tận dụng auth local; bao sau port riêng |
| Agent | `claude` và `codex` CLI | Worker process; capability/version kiểm tra bằng doctor |
| Logging | Pino | JSON logs có correlation và redaction |
| Testing | Vitest | Unit, integration, contract và E2E; Node environment |
| Quality | ESLint, typescript-eslint, Prettier | Lint/type/format nhất quán |
| Architecture guard | dependency-cruiser + script allowlist | Kiểm tra import direction, cycle, vị trí file |
| CI | GitHub Actions | Check PR, tests, schema drift, package smoke test |
| Artifact distribution | npm package/tarball có version | Cài riêng trong `.omi-squad/tool/` |

Tại thời điểm nghiên cứu, Node 24 và 26 đều thuộc các dòng LTS. Chọn 24 cho baseline bảo thủ, không khẳng định đây là LTS mới nhất. Xem [Node release status](https://nodejs.org/en/about/previous-releases).

## 3. Chính sách phiên bản

- Spike đầu tiên pin exact patch Node trong `.nvmrc`, exact dependency version và lockfile; `engines` ghi đúng range đã hỗ trợ.
- Không ghi các số version chưa kiểm thử như cam kết tương thích. File `docs/operations/compatibility.md` ghi OS, Node, Git, gh, Claude/Codex versions, auth mode, ngày kiểm tra và evidence.
- Chỉ một baseline Node được hỗ trợ chính thức trong bản đầu. Nâng major có Issue, CI matrix và ADR nếu đổi hành vi.
- Ghim framework version cho từng project. Update có diff preview, backup config, migrate state và khả năng quay lại phiên bản tương thích.
- Đối với CLI bên ngoài, doctor phân loại `supported`, `untested`, `unsupported`; phiên bản chưa biết không tự nhận là hoạt động đầy đủ.
- Native module `better-sqlite3` phải được kiểm tra trên Node/WSL2 baseline và đường cài sạch. Không copy `node_modules` từ Windows vào Linux.

## 4. Cấu hình TypeScript

Baseline compiler đề xuất:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "rootDir": "src",
    "outDir": "dist",
    "sourceMap": true,
    "declaration": true,
    "noEmitOnError": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "tests", "tools"]
}
```

`package.json` đặt `type: module`. Test/tools có tsconfig riêng. Dùng import type khi phù hợp; import relative theo quy tắc NodeNext và output `.js`. Không dùng alias compile-time mà Node runtime không resolve được. Không thêm `any`, non-null assertion hoặc `ts-ignore` chỉ để vượt check.

TypeScript `strict` tăng kiểm tra compile-time; không thay runtime validation cho JSON/YAML/CLI output. [Nguồn strict](https://www.typescriptlang.org/tsconfig/strict), [nguồn module](https://www.typescriptlang.org/tsconfig/).

## 5. Contract và cấu hình

Zod schemas nằm ở `src/application/contracts/`, dùng `z.infer` cho DTO. Sinh JSON Schema vào `schemas/`; không maintain hai bản schema bằng tay. Contract wire chỉ dùng kiểu JSON biểu diễn được; custom refinement liên quan nghiệp vụ được kiểm tra thêm bằng domain policy, không giả định JSON Schema truyền tải được mọi refinement.

Mỗi contract có schema version. Parse input trước khi xử lý; reject field không biết trong command nhạy cảm. YAML parser phải chặn duplicate key, custom tag không được phép và expansion vượt giới hạn; có giới hạn file size. Config error phải chỉ ra file, field và nguyên nhân.

Precedence đề xuất: baseline template → project config → local machine config → override phiên được cho phép. Mandatory approvals và requirement đã duyệt không bị override bằng một field runtime tùy ý. In ra resolved config không chứa secret, cùng hash lưu trong run.

Zod có static inference và chuyển JSON Schema; YAML parser chỉ chuyển định dạng, không validate nghiệp vụ. [Zod](https://zod.dev/), [YAML](https://eemeli.org/yaml/).

## 6. SQLite và artifact persistence

- Bật `foreign_keys`, `journal_mode=WAL`, `synchronous=FULL`; cấu hình busy timeout hữu hạn.
- Transaction ngắn, đồng bộ. Không `await` agent/network trong transaction của `better-sqlite3`.
- State change + event + outbox nằm trong cùng transaction.
- Migration tên `0001-initial-state.sql`, có checksum và lịch sử áp dụng; không sửa migration đã được dùng.
- Có backup trước migration, kiểm tra integrity và quy trình phục hồi. Rollback schema không được giả định tự động nếu migration làm mất dữ liệu.
- Runtime là writer chính; readonly CLI snapshot khi runtime dừng phải mở DB đúng chế độ và không chiếm writer lock.
- Không lưu log lớn vào mỗi hàng; DB giữ reference/hash, file giữ nội dung.
- Tài liệu recovery phải phân biệt SQLite WAL checkpoint với checkpoint nghiệp vụ của omi-squad.

WAL và durability là cấu hình phải hiểu, không copy mặc định không kiểm tra. Thư viện ghi rõ transaction callback không hỗ trợ async. [WAL/durability](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md), [transaction](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md).

## 7. Process, IPC và timeout

Sử dụng `spawn(executable, args, { shell: false, cwd, env })`; prompt dài truyền qua stdin hoặc file, không nối vào shell command. Adapter tách stdout event stream và stderr diagnostic, kiểm tra exit code cùng result payload. Exit code 0 chưa đủ chứng minh task đạt nghiệm thu.

Process group phải được quản lý để dừng cả subprocess; trước force-kill có grace period và xác minh identity process. Không kill theo tên executable chung vì có thể dừng phiên khác của PO.

IPC dùng request ID, protocol version, length/framing rõ và giới hạn payload. Unix socket có permission local hạn chế; đây không phải sandbox chống process cùng user. Slow consumer không được làm RAM tăng vô hạn: log stream ghi file, IPC chỉ chuyển event cần thiết và có backpressure.

Phân biệt: thời gian chạy tối đa, thời gian im lặng, thời gian chờ tài nguyên và thời gian chờ PO. Task chờ PO không bị tính như worker chạy quá lâu. Timeout/abort đều tạo trạng thái có thể reconcile.

## 8. Subscription và auth

Không thêm Anthropic/OpenAI API SDK chỉ để gọi model trực tiếp trong v1. Framework gọi CLI đã đăng nhập. Profile login ban đầu là thao tác tương tác của PO; runtime giữ reference và tình trạng, không tự nhận mật khẩu/OTP.

Đối với Codex, tài liệu chính thức cho phép auth cache ở file hoặc OS store, với state dưới `CODEX_HOME`; isolation phải được kiểm tra cả keyring và refresh. [Auth](https://learn.chatgpt.com/docs/auth), [state locations](https://learn.chatgpt.com/docs/config-file/config-advanced).

Đối với Claude Code, `claude -p` là điểm tích hợp; không dùng `--bare` cho đường subscription theo tài liệu hiện tại. Không giả định một biến profile/config chưa kiểm chứng có thể isolate tài khoản. [CLI programmatic](https://code.claude.com/docs/en/headless).

Không export API key từ môi trường ngoài vào worker một cách vô tình; nếu phát hiện mode auth không đúng cấu hình subscription thì báo lỗi. Không đưa credential lên GitHub Actions; live subscription test chạy local opt-in.

## 9. Logging và quan sát

Log JSON có `timestamp`, `level`, `event`, `projectId`, `sessionId`, `runId`, `stepId`, `attemptId`, `operationId`. Không log token/cookie/auth headers/full env hoặc nguyên transcript mặc định. Redaction theo field kết hợp kiểm tra dữ liệu mẫu; regex không bảo đảm che hết mọi secret.

PO xem summary ngắn: running/waiting/blocked, nguyên nhân, quyết định cần duyệt. Log debug rotation theo dung lượng/thời gian. Chỉ xóa artifact hết retention khi không còn checkpoint/run đang tham chiếu; không dọn worktree còn thay đổi chưa merge.

Metric local: task throughput, thời gian chờ, số quality failures, failover count, recovery success, outbox lag. Token/cost/quota không có dữ liệu thì `unknown`, không suy diễn thành 0. [Pino](https://github.com/pinojs/pino).

## 10. Bộ lệnh phát triển chuẩn

Các npm script cần được implement khi scaffold:

| Script | Mục đích |
|---|---|
| `build` | Compile production bằng tsc, copy asset cần thiết |
| `typecheck` | Kiểm tra source/test/tools với config phù hợp |
| `lint` / `format:check` | Coding conventions |
| `check:architecture` | Dependency graph, cycle, layer và root/file allowlist |
| `schemas:generate` / `schemas:check` | Sinh schema và phát hiện drift |
| `test:unit` | Domain/use cases với fake ports |
| `test:integration` | SQLite, Git, process, IPC thật trong temp |
| `test:contract` | Fixtures CLI/API schema theo version |
| `test:e2e` | Full flow với fake agent và sandbox local |
| `test:live` | Opt-in CLI subscription/GitHub, không thuộc CI mặc định |
| `pack:check` | npm pack, kiểm tra nội dung và smoke install trong thư mục sạch |
| `check` | Tập hợp kiểm tra bắt buộc không gồm live tests |

Vitest chọn Node environment; test cần OS process chạy integration, không chỉ mock mọi thứ. [Vitest](https://vitest.dev/guide/). Kiểm tra layer dùng [dependency-cruiser](https://github.com/sverweij/dependency-cruiser); parse lệnh dùng [Commander](https://github.com/tj/commander.js).

## 11. Cài đặt và phân phối

Build artifact chỉ chứa `dist/`, `templates/`, `schemas/`, `migrations/` và metadata/license cần thiết. `npm pack` phải loại toàn bộ `.omi-squad/local`, auth, fixtures nhạy cảm, coverage và source temp.

Project đích cài package version cố định trong `.omi-squad/tool/`. Shim `.omi-squad/bin/omi` resolve đường dẫn theo vị trí file, không theo cwd tùy ý. `omi init` có preview/dry-run, không ghi đè file người dùng ngoài phần managed marker. Update là ba chiều giữa bản mẫu cũ, tùy chỉnh project và bản mẫu mới; conflict được báo để xử lý.

Framework có thể được cài từ tarball local trước khi có npm registry. Chưa cần publish public để nghiệm thu. Không thay đổi package manager hoặc lockfile của ứng dụng đích.

## 12. Những thứ chưa đưa vào stack

Không dùng NestJS/Fastify/Express, React dashboard, Redis/RabbitMQ, PostgreSQL, Kubernetes, vector DB, workflow cloud hoặc DI container reflection trong bản đầu. SQLite repository đơn giản không cần ORM. Chưa cần event sourcing đầy đủ; state table + audit log + outbox đáp ứng phạm vi.

Khi cần thêm thành phần, Issue phải mô tả vấn đề thực tế, lựa chọn nhẹ hơn đã cân nhắc, ảnh hưởng dependency/cài đặt và test. Không cài dependency chỉ vì agent quen dùng.

## 13. Checklist trước PR

- File ở đúng layer/path; không thêm thư mục tùy tiện.
- Dependency có lý do, đúng layer, đã pin và kiểm tra license.
- Schema thay đổi có compatibility/migration và regenerated JSON Schema.
- Không secret hoặc state local trong diff/package.
- Kiểm tra phù hợp với thay đổi đã chạy; không báo pass nếu skip.
- CLI error/help/JSON đủ rõ cho PO và Coordinator.
- Với CLI/version/auth chưa chứng minh được, ghi trạng thái unsupported/untested và evidence cần bổ sung.
