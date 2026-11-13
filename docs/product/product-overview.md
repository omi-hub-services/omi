# omi-squad — Product Overview

Phiên bản: 1.0 · Ngày: 10/11/2026 · Ngôn ngữ: Tiếng Việt

Tài liệu đầu vào triển khai bằng Claude Code. Phạm vi sản phẩm được tổng hợp từ các quyết định của Product Owner (PO). Các chi tiết được ghi “đề xuất” là phương án thiết kế, không phải quyết định đã được PO xác nhận riêng. Kiến trúc triển khai nằm trong tài liệu `architecture.md` đi kèm.

## 1. Định nghĩa sản phẩm

**omi-squad là framework cài riêng vào từng project, biến phiên Claude Code chính thành Coordinator điều phối một đội agent Claude Code/Codex theo workflow để thực hiện công việc trên GitHub Issues và GitHub Project.**

PO giao ý tưởng, Issue cụ thể hoặc một phạm vi backlog. Coordinator làm rõ yêu cầu, chọn workflow, phân công vai trò, chọn công cụ/model đang khả dụng, theo dõi chất lượng và đưa công việc đến trạng thái hoàn thành. Mỗi step có một agent chịu trách nhiệm, được cung cấp đúng skills, rules, đầu vào và tiêu chí đầu ra.

Framework phải có runtime thực sự để chạy process, quản lý trạng thái, checkpoint, dependency, profile và đồng bộ GitHub. Tập hợp thư mục prompt/skills đơn thuần chưa đáp ứng mục tiêu sản phẩm.

### Giá trị cốt lõi

- PO tập trung vào nghiệp vụ, phạm vi, chi phí và các quyết định phát hành.
- Công việc được thực hiện theo quy trình có thể kiểm tra, thay vì phụ thuộc vào trí nhớ của hội thoại.
- Claude Code và Codex có thể đảm nhiệm cùng một vai trò tùy tài nguyên hiện có.
- Gián đoạn phiên hoặc hết hạn mức không làm mất dấu công việc đã làm.
- Mọi thay đổi có liên kết từ yêu cầu → Issue → workflow → kết quả kiểm tra → PR → release.

## 2. Phạm vi và người sử dụng

| Thành phần | Phạm vi đã chốt |
|---|---|
| Người sử dụng chính | PO trực tiếp điều khiển squad |
| Coordinator | Phiên làm việc chính của Claude Code, chạy trên Windows (ADR-0012) |
| Agent thực thi | Claude Code hoặc Codex |
| Đơn vị cài đặt | Mỗi project/repository cài riêng framework và cấu hình |
| Workspace | Một repository và một GitHub Project |
| Loại dự án | Dự án mới và dự án có sẵn |
| Môi trường bản đầu | Coordinator chạy trên Windows; runtime, agent thực thi, worktree và state chạy trong WSL2 (quyết định PO 10/11/2026, ADR-0012) |
| Giao diện | Phiên Claude Code, CLI riêng, GitHub Issues/Project/PR |
| Credential | Profile đăng nhập subscription; không lấy API key làm mô hình bản đầu |
| Khi đóng Coordinator | Dừng công việc, lưu checkpoint; PO mở phiên mới và yêu cầu tiếp tục |

Không xây dashboard web, hệ thống quản lý nhiều repository trong một workspace, Coordinator Codex, dịch vụ cloud hoặc runtime hoạt động tự trị liên tục khi đóng Coordinator trong phiên bản đầu.

## 3. Mô hình khái niệm

| Khái niệm | Ý nghĩa |
|---|---|
| Task | Công việc có mục tiêu, phạm vi, tiêu chí nghiệm thu; được đại diện bằng GitHub Issue |
| Workflow template | Quy trình mẫu có các step, dependency, điều kiện chuyển bước và điểm duyệt |
| Workflow run | Một lần áp dụng workflow cụ thể cho task; giữ phiên bản cấu hình đã sử dụng |
| Step | Một đơn vị xử lý với một agent chịu trách nhiệm; có thể phụ thuộc step khác |
| Role | Trách nhiệm chuyên môn như BA, Architect, Developer, QA, Reviewer |
| Agent run | Một lần chạy công cụ/model/profile để thực hiện một step hoặc tiếp tục step |
| Skill | Quy trình/chuyên môn tái sử dụng, được nạp theo role và step |
| Rule | Ràng buộc về cách làm, phạm vi, chất lượng hoặc phê duyệt |
| Profile | Tham chiếu tới môi trường đăng nhập subscription của một công cụ |
| Checkpoint | Trạng thái công việc và bằng chứng đủ để tiếp tục, độc lập với transcript của công cụ |
| Approval | Quyết định của PO gắn với một nội dung và phiên bản cụ thể |

Role, công cụ, model và profile là bốn khái niệm riêng biệt. Ví dụ, role Architect không bắt buộc chạy bằng Claude Code hay một model cố định.

## 4. Trách nhiệm và quyền quyết định

### 4.1. Product Owner

PO đưa ý tưởng, chọn phạm vi milestone/sprint/nhóm Issue, đặt ưu tiên và có thể chỉ định task cụ thể. PO phê duyệt thay đổi nghiệp vụ, tiêu chí nghiệm thu có ảnh hưởng đến phạm vi, chi phí mới, release và deploy production.

Yêu cầu hoặc chi phí đã được duyệt trong đúng phạm vi không phải xin duyệt lại cho mỗi step. Phê duyệt không còn đủ hiệu lực nếu nội dung thay đổi vượt phạm vi đã duyệt.

### 4.2. Coordinator

- Đánh giá độ sẵn sàng của task, phát hiện phần thiếu thông tin.
- Chọn workflow và điều chỉnh trong giới hạn cho phép; không bỏ bước kiểm tra/phê duyệt bắt buộc.
- Phân rã task thành kết quả bàn giao đủ nhỏ, thiết lập dependency.
- Tự chọn task trong phạm vi PO giao theo priority, dependency và tài nguyên.
- Chọn role, công cụ/model/profile đáp ứng yêu cầu tối thiểu của step.
- Theo dõi kết quả, xử lý lỗi, gọi Architect khi cần, cập nhật GitHub.
- Tự merge task PR khi đủ điều kiện, rồi tiếp tục công việc phù hợp.
- Tự quyết chi tiết kỹ thuật trong phạm vi đã duyệt; hỏi PO khi ảnh hưởng nghiệp vụ, nghiệm thu hoặc chi phí.

Coordinator không tự mở rộng milestone/phạm vi được giao và không tự chuyển vai trò Coordinator sang Codex.

### 4.3. Agent thực thi

Agent thực hiện một step, báo cáo bằng chứng và checkpoint, không tự điều phối toàn bộ backlog. Đội hình được chọn từ bộ role mẫu và tùy chỉnh theo codebase. Một người dùng không phải khởi động thủ công từng agent cho mỗi step.

Agent có toàn quyền thao tác trong môi trường dự án theo lựa chọn của PO. Không áp dụng một ma trận quyền công cụ hạn chế theo từng role trong bản đầu. Các điều kiện duyệt và merge vẫn bắt buộc. Quyền rộng không đồng nghĩa được tự mua dịch vụ, đổi nghiệp vụ, phát hành hoặc deploy production.

### 4.4. Runtime

Runtime thực thi quyết định, kiểm tra điều kiện chuyển trạng thái, quản lý process, tài nguyên, trạng thái bền vững và các thao tác GitHub. Runtime không thay Coordinator tự quyết nghiệp vụ.

## 5. Luồng sử dụng chính

1. PO cài omi-squad vào project và khởi tạo cấu hình.
2. Framework nhận diện repo mới/có sẵn, kiểm tra GitHub, công cụ và profile.
3. Dự án mới dùng mẫu GitHub Project; dự án cũ ánh xạ cấu trúc hiện tại, đề xuất phần thiếu và giữ nguyên công việc đang có.
4. PO giao ý tưởng, một Issue hoặc phạm vi backlog.
5. Coordinator làm rõ yêu cầu, chọn workflow, lập kế hoạch; xin duyệt tại các điểm được quy định.
6. Runtime tạo môi trường task; các step độc lập có thể chạy song song.
7. Agent thực hiện; reviewer độc lập và các kiểm tra đánh giá đầu ra.
8. Khi đạt điều kiện, tạo/cập nhật PR có liên kết Issue và merge vào `develop`.
9. Cập nhật task thành Done; tiếp tục task đủ điều kiện trong phạm vi đã giao.
10. Release dùng PR `develop` → `main`, phải được PO duyệt. Deploy production có phê duyệt riêng.

## 6. Workflow và đội hình mẫu

### 6.1. Quy tắc workflow

- Framework cung cấp template, project có thể chỉnh sửa.
- Step có một role chịu trách nhiệm; role có thể được thực thi bằng nhiều công cụ khác nhau.
- Step độc lập có thể chạy song song; step phụ thuộc chờ đầu ra đã được xác nhận.
- Workflow khai báo đầu vào, đầu ra, điều kiện thành công, retry, điểm duyệt và nhánh sửa lỗi.
- Không tự đổi template đang chạy theo bản cập nhật mới mà không ghi nhận quyết định và kiểm tra ảnh hưởng.
- Skills/rules được nạp có chọn lọc; tránh đưa toàn bộ thư viện vào mọi agent.

### 6.2. Bộ workflow phiên bản đầu

Đã chốt bao phủ một vòng đời hoàn chỉnh; danh sách dưới đây là cách nhóm workflow đề xuất để triển khai.

| Workflow | Đầu ra chính | Role thường dùng |
|---|---|---|
| Khởi tạo/tiếp nhận dự án | Báo cáo hiện trạng, cấu hình, mapping GitHub, kế hoạch bổ sung | Coordinator, Architect, DevOps |
| Phân tích ý tưởng/yêu cầu | Phạm vi, FR/NFR phù hợp, tiêu chí nghiệm thu, câu hỏi còn mở | BA, Architect |
| Thiết kế kiến trúc | Quyết định kỹ thuật, thành phần, contract và rủi ro | Architect, Reviewer |
| Thiết kế UI/UX | Luồng sử dụng, thiết kế và tiêu chí đánh giá UI | Designer, Frontend, QA |
| Lập kế hoạch/phân rã | Issue/sub-issue, dependency, độ ưu tiên và workflow | Coordinator, BA, Tech Lead |
| Feature | Code, test, tài liệu liên quan, PR vào `develop` | Developer, QA, Reviewer |
| Bugfix | Tái hiện lỗi, nguyên nhân, bản sửa, regression test | Developer, QA, Reviewer |
| Refactor | Thay đổi cấu trúc giữ hành vi đã duyệt, bằng chứng regression | Developer, Architect, Reviewer |
| Thiết lập CI/CD | Pipeline, cấu hình môi trường và kiểm tra vận hành | DevOps, Reviewer |
| Tài liệu | Tài liệu được review và khớp triển khai | Technical Writer, Reviewer |
| Release | Release Issue, PR vào `main`, changelog/tag/release | Release Manager, QA |
| Deploy production | Yêu cầu duyệt deploy, kết quả deploy và xác minh | DevOps, QA |

Bản đầu chỉ cần mức chức năng đủ dùng cho từng workflow; không yêu cầu mỗi role luôn là một process thường trực. Các workflow vận hành sự cố, kiểm tra bảo mật định kỳ và nâng cấp tự động nằm ngoài phạm vi ban đầu đã chọn.

## 7. Skills và rules

### 7.1. Nguồn tham khảo đã chốt

| Nguồn | Hướng chọn lọc đề xuất cho omi-squad |
|---|---|
| [Superpowers](https://github.com/obra/superpowers) | Phân tích trước khi code, lập kế hoạch, phát triển có kiểm chứng, review |
| [Taste](https://github.com/leonxlnx/taste-skill) | Chất lượng thiết kế frontend, tính nhất quán, kiểm tra giao diện thực tế |
| [Ponytail](https://github.com/dietrichgebert/ponytail) | Giải pháp đơn giản, tránh overengineering, giảm thay đổi không cần thiết |
| [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | Tư duy UI/UX, design system và lựa chọn thiết kế phù hợp |

Đây là định hướng tích hợp, chưa phải danh sách skill đã nhập hoặc được kiểm chứng. Chọn lọc nội dung và chuẩn hóa thành bộ mẫu riêng, không cài nguyên cả bốn bộ rồi để chúng cùng điều phối dự án.

Mỗi skill đã chuyển thể cần ghi nguồn, commit/version tham khảo, phần chỉnh sửa, license/attribution và các file/script đi kèm. Kiểm tra giấy phép của đúng tài nguyên được lấy, kể cả ảnh, dữ liệu hoặc dependency ngoài phần văn bản skill.

### 7.2. Vòng đời cải tiến

Khởi tạo bộ mẫu → tùy chỉnh theo dự án → review → áp dụng theo phiên bản. Agent có thể đề xuất cải tiến từ lỗi thực tế, nhưng không tự sửa rules để biến kết quả đang fail thành pass. Thay đổi không được tự nới lỏng các yêu cầu phê duyệt đã chốt.

## 8. Chọn công cụ/model và quản lý profile

- Công cụ/model được chọn theo tình trạng khả dụng thực tế, yêu cầu năng lực của step và danh sách thay thế cho phép.
- Không hardcode một model cho mỗi role và không giả định mọi profile có cùng quyền truy cập model.
- Có nhiều profile subscription Claude Code và nhiều profile subscription Codex.
- Khi agent gặp limit, lưu checkpoint, chuyển sang profile phù hợp và khởi chạy lại từ checkpoint.
- Nếu không có phương án đáp ứng năng lực, step chờ tài nguyên; task độc lập vẫn được xử lý.
- Credential giữ ở local, không commit, không đưa vào prompt, báo cáo hoặc GitHub.
- Khi Coordinator hết limit, PO tự mở phiên Claude Code bằng profile khác và yêu cầu khôi phục. Framework không tự thay profile của phiên chính.

**Cam kết phục hồi là tiếp tục công việc từ checkpoint, không phải chuyển nguyên bộ nhớ nội bộ hoặc transcript giữa các tài khoản/công cụ.** Đổi profile không đảm bảo hết limit nếu các profile thực chất dùng chung tài khoản/hạn mức.

Tự chuyển profile là yêu cầu sản phẩm cần PoC cho đúng phiên bản CLI và cơ chế đăng nhập được hỗ trợ. Nếu không khả thi, phải báo rõ giới hạn và đề xuất PO điều chỉnh phạm vi; không âm thầm thay bằng API key hoặc coi chuyển thủ công là đã đáp ứng tự động.

## 9. Task, GitHub Project và quy trình Git

### 9.1. Tổ chức công việc

- Task có Issue; task lớn tách sub-issue có kết quả độc lập.
- Step phân tích/code/review thông thường được quản lý trong runtime, cập nhật tóm tắt lên Issue.
- Task đủ nhỏ khi có một mục tiêu rõ, nghiệm thu được và review được độc lập.
- Số file, độ lớn diff hoặc thời lượng là tín hiệu chia nhỏ, không phải quy tắc chia máy móc.
- Dự án mới có bộ field/status mẫu; dự án cũ có mapping, không đổi tùy tiện field đang sử dụng.
- Dependency phải được kiểm tra trước khi giao task. Phát hiện vòng phụ thuộc thì chặn và báo nguyên nhân.

### 9.2. Branch, worktree và PR

| Loại | Quy tắc |
|---|---|
| `develop` | Nhánh tích hợp task |
| `main` | Nhánh release |
| Task branch | Tạo từ `develop`; mặc định một task một branch/worktree |
| Worktree bổ sung | Chỉ khi workflow cần nhiều agent sửa code đồng thời trong cùng task |
| Task PR | Vào `develop`, bắt buộc liên kết Issue |
| Release PR | Từ `develop` vào `main`, liên kết Release Issue, PO duyệt |
| Merge task | Tự động khi tất cả gate đạt và không còn phê duyệt bắt buộc đang chờ |
| Deploy production | Cần phê duyệt riêng, không suy ra từ phê duyệt release |

Trước merge phải kiểm tra lại với trạng thái nhánh đích mới nhất. Không dùng kết quả review/check của phiên bản code cũ để duyệt code đã thay đổi.

### 9.3. Định nghĩa Done

Task thay đổi code là Done khi đáp ứng nghiệm thu, kiểm tra/review bắt buộc và PR đã merge vào `develop`. Framework xác nhận merge thực tế, sau đó cập nhật Project và Issue theo chính sách.

Task không thay đổi code là Done khi đầu ra được nghiệm thu theo workflow. Release/deploy có vòng đời riêng; task đã Done không phải chờ deploy production.

GitHub xử lý closing keyword theo nhánh mặc định. Do đó không dựa riêng vào `Closes #...` để liên kết/đóng Issue của PR vào `develop`; phải có mapping PR–Issue rõ ràng và đồng bộ có kiểm chứng. Xem [tài liệu GitHub](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).

## 10. Review, retry và xử lý bế tắc

Reviewer được chọn theo workflow và mức độ ảnh hưởng. Task đơn giản có một reviewer độc lập; task phức tạp có thêm Architect, QA hoặc reviewer chuyên môn. Có thể review chéo Claude Code/Codex, không bắt buộc mọi task.

Agent thực hiện không tự duyệt kết quả của mình. “Pass review” phải có kết quả cấu trúc và bằng chứng, không chỉ một câu khẳng định thành công.

### Quy tắc 2 + Architect + 2

1. Thực hiện/sửa và đánh giá kết quả; sau hai lần không đạt, chuyển sang Architect.
2. Architect phân tích nguyên nhân và đề xuất giải pháp; không chỉ yêu cầu “thử lại”.
3. Áp dụng giải pháp, được thử thêm tối đa hai lần.
4. Nếu vẫn không đạt, dừng task, giữ checkpoint/lịch sử lỗi và báo PO.
5. Chặn các task phụ thuộc, tiếp tục các task độc lập.

Đề xuất cách đếm: một lần failed là một chu kỳ thực hiện/sửa đã được đánh giá không đạt; nhiều nhận xét trong cùng review chỉ là một lần. Limit, mất mạng hoặc hết phiên là lỗi vận hành, quản lý bằng bộ retry riêng có giới hạn, không tính vào bốn lần sửa chất lượng. Khi PO cho chạy lại task đã dừng, tạo quyết định mở lại và lưu lịch sử cũ.

## 11. Phê duyệt và tính tự chủ

| Tình huống | Xử lý |
|---|---|
| Chi tiết kỹ thuật trong phạm vi đã duyệt | Coordinator tự quyết |
| Yêu cầu thiếu nhưng không ảnh hưởng nghiệp vụ | Tự xác minh, ghi quyết định kỹ thuật |
| Thay đổi nghiệp vụ/nghiệm thu | Hỏi PO trước khi thực hiện phần thay đổi |
| Phát sinh chi phí ngoài phạm vi đã duyệt | Hỏi PO; không tự chuyển sang dịch vụ tính phí |
| Task đạt mọi gate | Tự merge vào `develop` |
| Release | PO duyệt PR `develop` → `main` |
| Deploy production | PO duyệt riêng cho release/artifact và môi trường cụ thể |

Phê duyệt có thể qua phiên/CLI hoặc Issue theo loại quyết định; release trên PR, deploy tại bước triển khai. Ghi người duyệt, thời gian, nội dung, phiên bản, kết quả và lý do từ chối nếu có. Agent không được coi lời phê duyệt trong văn bản do chính agent tạo là quyết định của PO.

## 12. Checkpoint, dừng và tiếp tục

Checkpoint cần chứa task/run/step, workflow và skills/rules version, đầu vào, quyết định, đầu ra, branch/worktree/commit, thay đổi chưa commit, kết quả kiểm tra, lỗi, số lần failed, phê duyệt và hành động tiếp theo.

Dừng chủ động: ngừng giao step mới, dừng agent an toàn và lưu trạng thái. Ngắt đột ngột: dùng checkpoint gần nhất, kiểm tra process, Git và GitHub để xác định việc gì đã hoàn thành trước khi tiếp tục. Không hứa lưu được trạng thái trong RAM tại đúng thời điểm máy bị tắt.

Khôi phục phải tránh tạo trùng Issue/PR/comment, merge lặp, deploy lặp hoặc cho hai agent cùng sửa một workspace. Việc đã hoàn thành và có bằng chứng hợp lệ được giữ lại; chỉ làm lại phần chưa hoàn thành hoặc bằng chứng đã mất hiệu lực.

## 13. CLI và báo cáo

CLI cần có khả năng khởi tạo, kiểm tra môi trường, quản lý profile, chọn phạm vi, chạy task/backlog, xem trạng thái, tạm dừng, tiếp tục, retry sau khi được phép và quản lý hàng chờ phê duyệt. Cú pháp cụ thể do tài liệu kiến trúc đề xuất.

Báo cáo cho PO phải trả lời được: đang làm gì, agent nào/công cụ nào đang chạy, vì sao đang chờ, cần PO quyết định gì, task nào đã hoàn thành và bước tiếp theo. GitHub giữ thông tin công việc dễ đọc; log process chi tiết nằm ở local và không chứa credential.

## 14. Yêu cầu chất lượng

- Có trạng thái bền vững, audit và khả năng phục hồi kiểm chứng được.
- Có giới hạn đồng thời cho project, công cụ/profile và thao tác ghi vào cùng worktree.
- Không bỏ qua gate khi đổi agent, đổi profile hoặc resume.
- Đầu ra có cấu trúc, kiểm tra được schema và bằng chứng.
- Không chạy nền tự trị khi Coordinator đã đóng.
- Cấu hình project có version; cập nhật framework không tự ghi đè phần tùy chỉnh.
- Phát hiện trạng thái công cụ/model không rõ thay vì báo khả dụng giả.
- Mất kết nối GitHub không làm mất kết quả local; đồng bộ lại không tạo trùng.
- Không dùng mức token/quota/cost ước tính như số chính xác khi công cụ không cung cấp dữ liệu.

## 15. Tiêu chí nghiệm thu bản đầu

| Kịch bản | Kết quả phải chứng minh |
|---|---|
| Khởi tạo repo mới và repo cũ | Có cấu hình chạy được, mapping GitHub đúng, không phá công việc hiện tại |
| Nhận ý tưởng | Tạo yêu cầu/kế hoạch, chờ duyệt đúng nơi rồi sinh task |
| Nhận Issue sẵn | Chọn workflow và thực hiện đến PR/Done |
| Hai task độc lập | Chạy song song, không ghi đè workspace |
| Claude Code và Codex | Cả hai thực hiện được step với context và kết quả chuẩn |
| Agent hết hạn mức | Chọn profile phù hợp và tiếp tục checkpoint; nếu PoC chưa đạt thì chưa được tính năng này hoàn tất |
| Coordinator hết hạn mức | PO mở phiên khác, khôi phục được trạng thái |
| Không đủ tài nguyên | Step chờ; task độc lập vẫn chạy |
| Chuỗi lỗi 2 + 2 | Architect được gọi đúng lúc, task dừng đúng giới hạn |
| Review | Agent thực hiện không tự duyệt; kết quả gắn đúng code revision |
| Merge | PR liên kết Issue, gate đạt, merge `develop`, task chuyển Done |
| Release/deploy | Hai điểm duyệt riêng; không deploy do chỉ có duyệt release |
| Ngắt đột ngột | Khôi phục và đối soát; không tạo trùng hoặc lặp thao tác đã thành công |
| Cải tiến skill | Thay đổi được review/version hóa, không tự vô hiệu hóa gate |

## 16. Trình tự triển khai đề xuất

1. PoC khả thi: chạy hai CLI bằng subscription, profile độc lập, chuyển profile, kết quả cấu trúc, dừng/resume và GitHub access.
2. Nền tảng: schema, runtime/state, CLI, checkpoint, adapter, quản lý worktree.
3. Luồng task hoàn chỉnh: Issue → workflow → agent → test/review → PR → `develop` → Done.
4. Mở rộng song song, 2 + Architect + 2, phê duyệt, đối soát GitHub.
5. Bao phủ workflow khởi tạo, phân tích, UI/UX, tài liệu, CI/CD, release và deploy.
6. Chuẩn hóa bộ skills tham khảo, chạy nghiệm thu và đóng gói cài riêng cho project.

Không coi PoC đơn lẻ là framework hoàn chỉnh. Bản đầu phải chứng minh toàn bộ vòng đời đã chọn, nhưng có thể triển khai từng lát chức năng để kiểm chứng dần.

## 17. Cơ sở kỹ thuật và giới hạn xác minh

Các tài liệu dưới đây xác nhận nền tảng tích hợp, không chứng minh omi-squad đã được triển khai:

- [Claude Code chạy programmatically](https://code.claude.com/docs/en/headless): có đường chạy CLI không tương tác; lựa chọn cờ chạy phải tương thích với subscription.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): cơ chế agent chuyên biệt trong Claude Code; không đồng nhất với process Codex bên ngoài.
- [Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode): đường tích hợp CLI cho tác vụ tự động; cần xác minh phiên bản được cài khi triển khai.
- [GitHub Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects): quản lý project qua API.

Các điểm bắt buộc kiểm chứng trước khi chốt release framework: profile subscription độc lập, khả năng phát hiện limit/model, lifecycle process WSL2, nhận diện đúng PO cho phê duyệt, và khả năng enforcement của repository/pipeline thực tế.

## Trạng thái hành vi CLI v0.1 (đối chiếu 2026-11-13)

Luồng §5 là mục tiêu sản phẩm; CLI hiện chạy từng bước `plan` → `dispatch` → `wait` →
`worker-report` → `deliver`, không có `run`/`retry`/`sync`/`login` trong v0.1. Login thực hiện
bằng native tool; registry dùng `profiles register/list/probe`. Install/update preview mặc định,
chỉ ghi bằng `--apply`. `commit-worker` commit output attempt đã dừng; `review-comment` kiểm
verdict độc lập trước khi post; đây không phải PO approval. Business approval yêu cầu snapshot
đã import; deploy approval gắn digest/environment trong config (ADR-0037).

Nguồn: `src/interfaces/cli/commands/`, `src/application/use-cases/tasks/store-task-snapshots.ts`,
[handbook](../operations/handbook.md) và [bản ghi chạy CLI](../operations/cli-verification.md).
Source repository dùng bridge bảo trì và tooling pin ngoài worktree (ADR-0036), không cài runtime
vào source. Đường Windows/session, GitHub và subscription live không được lần đối chiếu offline
này chứng nhận lại. Chu kỳ 2 + Architect + 2 của repo còn là procedure, không phải runtime state
automatically enforced (ADR-0036).
