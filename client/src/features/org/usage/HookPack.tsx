import React from "react";
import { Terminal } from "lucide-react";
import CopyBlock from "../CopyBlock";
import { Hint } from "../Hint";

/**
 * Install instructions for the Claude Code hook pack and the CI reporters.
 *
 * Every block is runnable as printed: the origin is where this page is served
 * from and the token is whatever the admin pasted into the field above, so there
 * is nothing to substitute by hand. Without a token the blocks still make sense —
 * the placeholder is obviously a placeholder.
 */

const REPO_RAW = "https://raw.githubusercontent.com/danimoya/ptd/main/hooks/claude-code";

export default function HookPack({ origin, token }: { origin: string; token: string }) {
  const tok = token.trim() || "ptd_your_agent_seat_token";

  const install = [
    "mkdir -p ~/.claude/ptd && cd ~/.claude/ptd",
    `curl -fsSLO ${REPO_RAW}/ptd-hook-common.sh`,
    `curl -fsSLO ${REPO_RAW}/ptd-session-start.sh`,
    `curl -fsSLO ${REPO_RAW}/ptd-session-stop.sh`,
    "chmod +x ptd-session-start.sh ptd-session-stop.sh",
  ].join("\n");

  const settings = JSON.stringify(
    {
      env: { PTD_URL: origin, PTD_TOKEN: tok },
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "$HOME/.claude/ptd/ptd-session-start.sh", timeout: 30 }] }],
        Stop: [{ hooks: [{ type: "command", command: "$HOME/.claude/ptd/ptd-session-stop.sh", timeout: 30 }] }],
      },
    },
    null,
    2,
  );

  const verify = [
    `PTD_URL=${origin} PTD_TOKEN=${tok} \\`,
    `  printf '{"session_id":"probe","hook_event_name":"SessionStart"}' | ~/.claude/ptd/ptd-session-start.sh`,
    "",
    "# → [ptd-hook] started entry #42 (agent) on … — then stop it again:",
    `PTD_URL=${origin} PTD_TOKEN=${tok} \\`,
    `  printf '{"session_id":"probe"}' | ~/.claude/ptd/ptd-session-stop.sh`,
  ].join("\n");

  const agentRun = [
    `export PTD_URL=${origin} PTD_TOKEN=${tok}`,
    "",
    "# Times the command, reports whatever it printed, attests the figure.",
    "ptd agent-run --task SEC-3 -- python fix_forms.py",
    "",
    "# How the wrapped program reports its usage (either will do):",
    '#   echo "PTD_USAGE {\\"tokens\\":143793,\\"model\\":\\"claude-opus-5\\"}"',
    '#   echo \'{"usage":{"input_tokens":363,"output_tokens":2430,"cache_read_input_tokens":138000},"model":"claude-opus-5"}\' > "$PTD_TOKENS_FILE"',
  ].join("\n");

  const workflow = [
    "- uses: danimoya/ptd/.github/actions/ptd-report@main",
    "  with:",
    `    url: ${origin}`,
    "    token: ${{ secrets.PTD_TOKEN }}",
    "    task: SEC-3",
    "    usage-file: usage.json   # or: tokens / cost / model",
    "    minutes: 4",
  ].join("\n");

  return (
    <section className="space-y-3" data-testid="hook-pack">
      <div>
        <div className="eyebrow text-[9px]">Hook pack</div>
        <h3 className="mt-0.5 font-display text-xl tracking-tight">
          Make the numbers <span className="italic">checkable</span>
        </h3>
        <p className="mt-1 max-w-prose font-serif text-sm text-ink-muted">
          Two shell scripts. The first opens a time entry when a Claude Code session starts; the second closes it, sums the
          session transcript's <code>usage</code> blocks, reports that figure, and then attests it with the transcript's
          SHA-256, the turn count and the model. POSIX <code>sh</code>, <code>curl</code>, and <code>python3</code> or{" "}
          <code>node</code> — nothing else to install. Both exit 0 whatever happens: a tracker that can break a coding session
          is a tracker people turn off.
        </p>
      </div>

      <div className="grid min-w-0 items-start gap-3 lg:grid-cols-2">
        <div className="paper-flat min-w-0 p-3">
          <div className="flex items-baseline gap-2">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <span className="microcaps">1 · fetch the scripts</span>
            <span className="stamp ml-auto shrink-0 border-rule text-ink-muted">sh</span>
          </div>
          <p className="mb-2 mt-1.5 font-serif text-xs italic text-ink-muted">
            All three files together — the two hooks share their JSON and config plumbing.
          </p>
          <CopyBlock body={install} testId="hook-install" />
        </div>

        <div className="paper-flat min-w-0 p-3">
          <div className="flex items-baseline gap-2">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <span className="microcaps">2 · ~/.claude/settings.json</span>
            <Hint text="Merge these keys into the file; do not replace it. Per-repository settings work the same way in .claude/settings.json." />
            <span className="stamp ml-auto shrink-0 border-rule text-ink-muted">json</span>
          </div>
          <p className="mb-2 mt-1.5 font-serif text-xs italic text-ink-muted">
            The token is this org's agent seat. Leave <code>env</code> out if you would rather run <code>ptd login</code> —
            the hooks read <code>~/.config/ptd/config.json</code> too.
          </p>
          <CopyBlock body={settings} testId="hook-settings" />
        </div>

        <div className="paper-flat min-w-0 p-3">
          <div className="flex items-baseline gap-2">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <span className="microcaps">3 · name the card (optional)</span>
            <span className="stamp ml-auto shrink-0 border-rule text-ink-muted">sh</span>
          </div>
          <p className="mb-2 mt-1.5 font-serif text-xs italic text-ink-muted">
            A repository can label itself. Without one, the hook books the session against{" "}
            <code>next_task {"{assignee:\"me\"}"}</code>.
          </p>
          <CopyBlock body={'echo "SEC-3" > .ptd-task     # or: export PTD_TASK=SEC-3'} testId="hook-task" />
        </div>

        <div className="paper-flat min-w-0 p-3">
          <div className="flex items-baseline gap-2">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <span className="microcaps">4 · prove it works</span>
            <span className="stamp ml-auto shrink-0 border-rule text-ink-muted">sh</span>
          </div>
          <p className="mb-2 mt-1.5 font-serif text-xs italic text-ink-muted">
            Feeds the hooks the payload Claude Code would. Running the start hook twice is safe — it leaves a running timer alone.
          </p>
          <CopyBlock body={verify} testId="hook-verify" />
        </div>

        <div className="paper-flat min-w-0 p-3">
          <div className="flex items-baseline gap-2">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <span className="microcaps">any command · ptd agent-run</span>
            <span className="stamp ml-auto shrink-0 border-rule text-ink-muted">sh</span>
          </div>
          <p className="mb-2 mt-1.5 font-serif text-xs italic text-ink-muted">
            For agents that are not Claude Code. The command's exit code becomes the CLI's, so it drops into a Makefile unchanged.
          </p>
          <CopyBlock body={agentRun} testId="hook-agent-run" />
        </div>

        <div className="paper-flat min-w-0 p-3">
          <div className="flex items-baseline gap-2">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <span className="microcaps">GitHub Actions</span>
            <Hint text="The composite action wraps `ptd ci-report` and records the repository, workflow, job, run id, attempt, commit and actor as the attestation's evidence." />
            <span className="stamp ml-auto shrink-0 border-rule text-ink-muted">yaml</span>
          </div>
          <p className="mb-2 mt-1.5 font-serif text-xs italic text-ink-muted">
            Store the seat's token as the <code>PTD_TOKEN</code> repository secret. A human credential will not do: PTD records
            tokens and cost only for agent-sourced entries.
          </p>
          <CopyBlock body={workflow} testId="hook-workflow" />
        </div>
      </div>

      <p className="max-w-prose font-serif text-xs italic text-ink-muted">
        What lands where: <code>time_entry.stop</code> writes the agent's own <code>tokensUsed</code> / <code>apiCostUsd</code>,
        then <code>time_entry.attest</code> writes <code>verifiedTokens</code> / <code>verifiedCostUsd</code> /{" "}
        <code>verifiedSource</code> / <code>verifiedAt</code> beside them. Neither overwrites the other — Overview → Agents shows
        the pair, the coverage, and every session whose two figures disagree by more than the tolerance.
      </p>
    </section>
  );
}
