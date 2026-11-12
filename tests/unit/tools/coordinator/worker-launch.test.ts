import { describe, expect, it } from "vitest";
import {
  claudeLaunchPayload,
  codexLaunchPayload,
  curatedSkills,
  promptWithSkills,
  runsPath,
  skillPath,
} from "../../../../tools/coordinator/worker-launch.ts";

const claude = {
  task: "077",
  profile: "ggtintran",
  model: "claude-sonnet-5-5",
  effort: "medium",
  resume: null,
} as const;
const codex = { ...claude, model: "gpt-6.1-sol" } as const;

describe("curatedSkills", () => {
  it("gives a Developer the three skills of OMI-073", () => {
    expect(curatedSkills("Developer", "feature")).toEqual([
      "test-driven-development",
      "minimal-change",
      "verification-before-completion",
    ]);
  });

  it("drops test-driven-development for the docs workflow", () => {
    expect(curatedSkills("Developer", "docs")).toEqual([
      "minimal-change",
      "verification-before-completion",
    ]);
  });

  it("gives no skills to a role without a curated worker set", () => {
    expect(curatedSkills("Reviewer", "feature")).toEqual([]);
    expect(curatedSkills(null, null)).toEqual([]);
  });
});

describe("promptWithSkills", () => {
  it("appends each skill under the heading omi-next uses, after the prompt", () => {
    const out = promptWithSkills("Do the task.\n", [
      { name: "minimal-change", body: "# Minimal\n" },
      { name: "verification-before-completion", body: "# Verify\n" },
    ]);
    expect(out).toBe(
      "Do the task.\n" +
        "\n\n## Skill: minimal-change (follow it; report it under Skills applied)\n\n# Minimal\n" +
        "\n\n## Skill: verification-before-completion (follow it; report it under Skills applied)\n\n# Verify\n",
    );
  });

  it("returns the prompt unchanged with no skills", () => {
    expect(promptWithSkills("x", [])).toBe("x");
  });
});

describe("paths", () => {
  it("names the prompt and the curated skill files", () => {
    expect(runsPath("077", "prompt.md")).toBe("$HOME/omi-runs/omi-077-prompt.md");
    expect(skillPath("minimal-change")).toBe(
      "templates/project/.omi-squad/skills/minimal-change/SKILL.md",
    );
  });

  it("rejects a skill name that could leave the skills directory", () => {
    expect(() => skillPath("../../etc/passwd")).toThrow(/skill/);
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
    expect(payload).toContain("< $HOME/omi-runs/omi-077-prompt.md");
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

  it("writes the last message to omi-NNN-codex-last.md and the stream to a codex-named log", () => {
    expect(payload).toContain("-o $HOME/omi-runs/omi-077-codex-last.md");
    expect(payload).toContain("< $HOME/omi-runs/omi-077-prompt.md");
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
