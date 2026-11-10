# ADR-0022 — Phân biệt tham chiếu config và credential trong context

- Status: Accepted
- Date: 2026-11-10
- Issue: #82 (OMI-058)
- Context: architecture.md §6.2; design-patterns.md §9; AGENTS.md §6

## Bối cảnh

Guard hiện tại coi tên thư mục config và biến chọn profile là credential. Điều đó chặn cả
architecture.md và compatibility.md, dù các tài liệu này chỉ mô tả cấu hình. OMI-032 cần
nạp tóm tắt có nguồn mà vẫn chặn auth file và dữ liệu bí mật.

## Quyết định và phạm vi ngoại lệ

Thay quy tắc chặn toàn bộ cây config trong `credential-input.ts` bằng nhận diện file
credential cụ thể và assignment có secret literal. Ngoại lệ đối với heuristic cũ chỉ cho
phép văn bản nhắc `.claude/`, `.codex/`, các thư mục profile, `.npmrc`, `CODEX_HOME`,
`CLAUDE_CONFIG_DIR` và metadata/config không chứa credential. Không có ngoại lệ theo tên
tài liệu, role hoặc loader, và không bypass guard khi tạo sourced summary.

Tiếp tục chặn auth/credentials JSON, `.env`, key SSH, `.netrc`, `.git-credentials`,
`.aws/credentials` và `.config/gh/hosts.yml`. Với tên file không phần mở rộng `credentials`
ở path bất kỳ, chỉ nhận diện khi kết thúc chuỗi hoặc có quote/dấu câu đóng, tránh coi cặp
từ trong prose như state/credentials là file. Nội dung npm config có `_authToken`, `_auth`
hoặc `_password` assignment bị chặn; chỉ nhắc tên `.npmrc` được phép. Structured field
credential/environment, giá trị bí mật đã biết và credential root do caller truyền vẫn
bị chặn. Loader không tự đọc auth file để tóm tắt.

Giữ heuristic thuần, không I/O, entropy hay LLM. Assignment case-insensitive nhận diện
secret-bearing segment có prefix và các tên DB phổ biến. Giá trị có quote phải là literal
không chứa template expression; giá trị không quote cần ít nhất 8 ký tự và số hoặc dấu
của token; Bearer còn nhận diện từ opaque dài ít nhất 24 ký tự. Nhận diện định dạng key,
PEM và URL userinfo được giữ nguyên. Đây là best effort, không thay parser ngôn ngữ hoặc
việc caller truyền secret/root đã biết qua `CredentialPolicy`.

## Lý do và hệ quả

File config và tên biến chọn profile không tự chứa secret. Chặn chúng buộc summary phải
đổi tên hoặc diễn đạt vòng và làm mất thông tin vận hành mà không chứng minh an toàn hơn.
Phân biệt theo nội dung và file cụ thể là thay đổi nhỏ tại guard chung, không cần loader
riêng hoặc schema mới. Corpus kiểm tra cả tài liệu thật, các ví dụ code/prose và các
credential giả; các trường hợp reject cũ chỉ đổi nhóm đối với tham chiếu config đã nêu.

Một config file vẫn có thể chứa secret không nhận diện được. Catalog phải được review,
guard chạy trên metadata, bytes, JSON đã parse và packet; caller phải cung cấp giá trị và
root nhạy cảm đã biết. Không dependency, migration hoặc cấu trúc module nào thay đổi.
