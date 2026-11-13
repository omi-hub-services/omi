import { describe, expect, it } from "vitest";
import {
  claudeLaunchPayload,
  codexLaunchPayload,
  promptFile,
  runsPath,
} from "../../../../tools/coordinator/worker-launch.ts";

const claude = {
  task: "077",
  profile: "ggtintran",
  model: "claude-sonnet-5-5",
  effort: "medium",
  resume: null,
  packet: "verify-1",
} as const;
const codex = { ...claude, model: "gpt-6.1-sol" } as const;

it("names the transported prompt file", () => {
  expect(runsPath("077", "prompt-verify-1.md")).toBe("$HOME/omi-runs/omi-077-prompt-verify-1.md");
});

describe("packet files of parallel dispatches (OMI-111)", () => {
  it("gives two dispatches of one task different packet and resume files", () => {
    const qa = { ...claude, packet: "verify-1" };
    const review = { ...claude, packet: "review-1" };
    expect(promptFile(null, qa.packet)).toBe("prompt-verify-1.md");
    expect(promptFile("sess", qa.packet)).toBe("resume-verify-1.md");
    expect(promptFile(null, review.packet)).not.toBe(promptFile(null, qa.packet));
    expect(claudeLaunchPayload(qa)).toContain("< $HOME/omi-runs/omi-077-prompt-verify-1.md");
    expect(claudeLaunchPayload(review)).toContain("< $HOME/omi-runs/omi-077-prompt-review-1.md");
    expect(claudeLaunchPayload(review)).not.toContain("prompt-verify-1");
  });

  it("refuses a packet id that could break out of the payload", () => {
    expect(() => claudeLaunchPayload({ ...claude, packet: "a;id" })).toThrow(/packet/);
  });
});

describe("claudeLaunchPayload", () => {
  const payload = claudeLaunchPayload(claude);

  it("is safe for wsl.exe: no double quotes, backslashes or newlines", () => {
    expect(payload).not.toMatch(/["\\\n\r]/);
  });

  it("sets the profile, drops API keys and disables native skills", () => {
    expect(payload).toContain("export CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/ggtintran;");
    expect(payload).toContain("unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;");
    expect(payload).toContain("claude -p --disable-slash-commands");
  });

  it("passes the model and effort from the policy and the stream-json flags", () => {
    expect(payload).toContain("--model claude-sonnet-5-5 --effort medium");
    expect(payload).toContain("--output-format stream-json --verbose --max-turns 200");
    expect(payload).toContain("--permission-mode acceptEdits");
  });

  it("allows the default tools and denies push, hard reset and the other known-bad forms", () => {
    expect(payload).toContain("--allowedTools Read Edit Write Grep Glob TodoWrite");
    expect(payload).toContain("'Bash(git add *)'");
    expect(payload).toContain("'Bash(npm run *)'");
    for (const denied of [
      "git push*",
      "git reset --hard*",
      "gh api*",
      "npm install*",
      "git commit --no-verify*",
      "git commit -n*",
      "git commit --amend*",
      "git switch --discard-changes*",
      "git switch -C*",
      "git switch -f*",
      "git switch --force*",
    ]) {
      expect(payload.split("--disallowedTools")[1]).toContain(`'Bash(${denied})'`);
    }
    expect(payload.split("--disallowedTools")[0]).not.toContain("git push");
  });

  it("reads the prompt file and logs to omi-NNN-<profile>-<ts>.jsonl and .err", () => {
    expect(payload).toContain("ts=$(date +%Y%m%d-%H%M%S);");
    expect(payload).toContain("< $HOME/omi-runs/omi-077-prompt-verify-1.md");
    expect(payload).toContain("> $HOME/omi-runs/omi-077-ggtintran-$ts.jsonl");
    expect(payload).toContain("2> $HOME/omi-runs/omi-077-ggtintran-$ts.err; echo exit=$?");
  });

  it("resumes a session with --resume and keeps the same log naming", () => {
    const resumed = claudeLaunchPayload({
      ...claude,
      resume: "11111111-2222-3333-4444-555555555555",
    });
    expect(resumed).toContain("--resume 11111111-2222-3333-4444-555555555555");
    expect(resumed).toContain("> $HOME/omi-runs/omi-077-ggtintran-$ts.jsonl");
    // the follow-up never replaces the thread's full packet that the watch reads skills from
    expect(resumed).toContain("< $HOME/omi-runs/omi-077-resume-verify-1.md");
    expect(resumed).not.toContain("omi-077-prompt-verify-1.md");
  });

  it("refuses values that could break out of the payload", () => {
    expect(() => claudeLaunchPayload({ ...claude, profile: "a;rm -rf ~" })).toThrow(/profile/);
    expect(() => claudeLaunchPayload({ ...claude, resume: "x; id" })).toThrow(/resume/);
    expect(() => claudeLaunchPayload({ ...claude, model: "m o" })).toThrow(/model/);
    expect(() => claudeLaunchPayload({ ...claude, task: "7/7" })).toThrow(/task/);
  });
});

describe("codexLaunchPayload", () => {
  const payload = codexLaunchPayload(codex);

  it("is safe for wsl.exe", () => {
    expect(payload).not.toMatch(/["\\\n\r]/);
  });

  it("runs codex exec --json in the workspace-write sandbox with the policy model and effort", () => {
    expect(payload).toContain("export CODEX_HOME=$HOME/.codex-profiles/ggtintran;");
    expect(payload).toContain(
      "codex exec --json -s workspace-write -m gpt-6.1-sol -c model_reasoning_effort=medium",
    );
  });

  it("writes the last message next to its own log and the stream to a codex-named log", () => {
    expect(payload).toContain("-o $HOME/omi-runs/omi-077-codex-ggtintran-$ts-last.md");
    expect(payload).toContain("< $HOME/omi-runs/omi-077-prompt-verify-1.md");
    expect(payload).toContain("> $HOME/omi-runs/omi-077-codex-ggtintran-$ts.jsonl");
    expect(payload).toContain("2> $HOME/omi-runs/omi-077-codex-ggtintran-$ts.err; echo exit=$?");
  });

  it("does not use Claude flags", () => {
    expect(payload).not.toContain("--allowedTools");
    expect(payload).not.toContain("claude");
  });

  it("resumes through codex exec resume <thread>, with the options before the subcommand", () => {
    const resumed = codexLaunchPayload({
      ...codex,
      resume: "0199aaaa-bbbb-cccc-dddd-eeeeffff0000",
    });
    expect(resumed).toContain(
      "codex exec --json -s workspace-write -m gpt-6.1-sol -c model_reasoning_effort=medium",
    );
    expect(resumed).toContain("resume 0199aaaa-bbbb-cccc-dddd-eeeeffff0000 -");
    expect(resumed.indexOf("-o ")).toBeLessThan(resumed.indexOf("resume "));
  });
});
