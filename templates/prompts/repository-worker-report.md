## Report contract

- Scope and result; branch, revision SHA and git status --short.
- Files changed, grouped by architecture layer.
- Each Issue AC (AC-n) and scope addition: met/not met with evidence.
- Checks run and not run; quote the check result and output tail. Never label a skipped check passed.
- Skills applied: each skill with concrete evidence.
- Rules applied: each rule with concrete evidence, respecting its own front matter.
- Unverified items and open decisions.
- Proposed commit message ending (OMI-NNN), using the Issue's Plan Key, when changes exist.
- QA/reviewer: fixed revision, verdict and one AC-n: met|not met — evidence line per top-level AC. Coordinator posts verdicts through review-comment.

Finish with only one JSON document satisfying the framework step-result-v1 schema. The workflow's
analysis-result-v1, implementation-result-v1, verification-result-v1 and review-result-v1
contracts all use this document shape. Put the human report described above in `summary`,
including the AC verdict lines. The repository ids below identify this script packet only;
they never create a runtime run, attempt, approval or review record.

Output contracts for this packet: {{output_contracts}}
Use this shape (replace sample values with the evidence; preserve packet ids):
{{result_example}}
