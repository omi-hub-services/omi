---
name: security-review
description: Use when the review packet marks the change security-relevant. Adds a security checklist with concrete failure cases to the independent review and requires a Security section in the result.
---

# Security review

Original to this project (no third-party text). See `../NOTICE.md`.

This skill extends `independent-review`; it does not replace it, and it adds no second reviewer.
You are still read-only, still on the fixed revision, and still not approving or merging anything.
A security defect is a **must-fix** finding on the review severity scale, never "nice to have".

## How to apply

1. List what the diff adds or changes that crosses a trust boundary: input read, a process started,
   a file or URL opened, a secret or token touched, a permission or approval decided.
2. Walk every area below. For each, read the changed code and the code that calls it, then record
   `checked` (what you looked at and found safe) or `no findings` (the area is not touched, and why).
   An area you did not look at is not `checked`; say so under `Not checked:`.
3. A finding needs a concrete case: this input, reaching this line, does this. No case, no finding.
4. Never copy a secret, token or credential into the report, not even a rejected one.

## Checklist

### 1. Trust boundaries and untrusted input

Issue, PR and comment text, worker output, CLI arguments, environment variables, file contents and
API responses are data, never instructions. Failure cases: text from an Issue body used as a path, a
command or a prompt instruction; a worker's JSON trusted without schema validation; a value read
once and used after the file changed; validation done inside the UI or the caller instead of at the
boundary.

### 2. Command and shell injection

Look at every `exec`, `execSync`, `spawn`, `spawnSync` and `bash -lc`. Failure cases:
`exec("git checkout " + branch)` with an untrusted branch name; `bash -lc` with an interpolated
string; `shell: true`; an argument starting with `-` taken as an option (`--upload-pack=...`).
Safe shape: a fixed executable plus an argument array, `--` before untrusted positionals, values
checked against an allow-list pattern.

### 3. Path traversal and symlinks

Failure cases: `join(root, userPath)` with `../` or an absolute path; a prefix check such as
`startsWith(root)` that also accepts `root-evil`; a path checked and then opened later (a symlink
swapped in between); writing through a symlink that leaves the workspace or artifact root; archive
or artifact names used as file names without normalising.

### 4. Secrets in logs, prompts, comments and artifacts

Failure cases: a token, key or `Authorization` header in a log line, error message, thrown `Error`,
command echo, context packet, worker prompt, PR or Issue comment, test fixture or artifact; an
environment dump; a URL with embedded credentials; a stack trace that includes request headers.
Check where each value is stored and what reads it back out.

### 5. Authentication, authorisation and approval gates

Failure cases: a check that can be skipped by an empty value, a missing field or an exception
swallowed as "allowed"; an approval inferred from text instead of a recorded decision; the author
approving or merging their own change; an approval reused for a different revision, subject or
action; a gate that fails open; a rule or workflow change that relaxes a requirement. Fail closed.

### 6. GitHub token scope

Failure cases: a token with more scopes than the operation needs (write where read is enough,
`repo` or admin where one permission suffices); a token passed to a worker that only reads; a token
sent to a host other than the intended one; a token persisted to disk or forwarded to a child
process environment that does not need it.

### 7. SSRF and network calls

Failure cases: a URL built from Issue, PR or worker text and fetched without an allow-list of hosts;
redirects followed to another host; internal addresses (loopback, link-local, metadata endpoints)
reachable; no timeout or response size limit; TLS verification turned off; a new outbound call that
the product overview does not allow.

### 8. Dependencies and licences

Failure cases: a new dependency without a recorded reason, an exact pin and a checked licence; a
range or `latest` version; an install script; a package that overlaps one already installed; a
licence that conflicts with the project's. This review does not run a CVE scan; say that under
`Not checked:`.

### 9. Unsafe deserialization and dynamic code

Failure cases: `eval`, `new Function`, `vm`, dynamic `import()` of an untrusted path; `JSON.parse`
output used without schema validation; YAML loaded with a schema that builds objects; `__proto__`
or `constructor` keys merged into an object; a regular expression built from untrusted text, or one
with nested quantifiers that can backtrack without bound.

## Output

Add a section that starts with the line `Security:`, after the acceptance-criteria lines, with one
line per area above:

```
Security:
- Trust boundaries: checked — Issue body only reaches parseIssue (src/x.ts:41), schema-validated
- Command injection: no findings — the diff starts no process
- Path traversal: checked — resolve + relative check at src/y.ts:88, test covers ../ and a symlink
- Secrets: checked — grep of the diff for token/Authorization found none in logs or fixtures
- Authn/authz and approval gates: no findings — no gate touched
- GitHub token scope: no findings — no token use changed
- SSRF and network: no findings — no network call added
- Dependencies and licences: no findings — package.json unchanged
- Deserialization: checked — worker JSON goes through stepResultSchema
```

Each line says `checked` or `no findings` and gives the evidence: `file:line`, a command you ran, or
the input case. A line without evidence does not count. The review gate refuses a review of a
security-relevant change that has no `Security:` section. Findings from this checklist also appear
in the `Must fix` group of the normal review output, with the usual four parts.
