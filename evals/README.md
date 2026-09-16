# Tool-selection evals

`evals/prompts.json` holds 25 prompts that a 3PL ops person or account manager might type to an assistant connected to the Extensiv MCP server. Each prompt is scored on **which tool the model calls first**, nothing else. The fixture assumes the mock data set: customer Acme Outdoor Co (in the write allow-list), customer Globex Industries (customer 77, read-only), facility Reno, SKUs `ACME-TENT-2P`, `ACME-STOVE-1`, orders `ACME-SO-100xx`, receipt `88213`.

## Prompt record

```json
{
  "id": "E01",
  "prompt": "what the user types",
  "expected_tool": "verify_connection",
  "acceptable_tools": ["operations_summary", "find_stuck_orders"],
  "expected_args_contains": { "reference_number": "ACME-SO-10007" },
  "requires_writes_enabled": false,
  "category": "read",
  "rationale": "why this tool and not the neighbours"
}
```

| Field | Meaning |
|---|---|
| `expected_tool` | The single best first call. |
| `acceptable_tools` | Optional. If present, any of these counts as correct (used for the two `ambiguous` prompts and one `policy` prompt). |
| `expected_args_contains` | Optional, informational. Key/value pairs the runner looks for in the first tool call's arguments. Key names follow the server's tool schemas; if a schema uses a different name the runner reports the mismatch but does not change the score. |
| `requires_writes_enabled` | Which tool list the runner must present: `true` = all 16 tools; `false` = only the 11 read tools (the server does not register write tools unless `EXTENSIV_MCP_WRITES_ENABLED=true`). |
| `category` | `read`, `write-prepare`, `commit`, `policy`, `ambiguous`. |
| `rationale` | Human explanation, also useful when a miss is reviewed. |

Categories worth understanding before reading results:

- `read` includes three prompts (E18, E19, E20) whose wording sounds like an action (ship, release hold, confirm receipt). Those operations are intentionally not exposed by the server, so the correct first call is the read tool that shows the current state. Picking a write tool, or no tool, is a miss.
- `policy` prompts (E21, E22) run with writes disabled. The correct behaviour is to pick the relevant read tool and explain that writes are off; the runner cannot score the explanation, only the first tool.
- `write-prepare` includes E25, a write for a customer outside the write allow-list. The expected tool is still `create_order`: the refusal happens inside the tool. A model that pre-empts the policy and calls a read tool instead is scored as a miss, because that behaviour hides the server's own error message from the user.
- `commit` prompts contain an explicit `chg_...` id and an explicit go-ahead.

## Scoring rule

For each prompt: **1 point** if the first tool the model calls equals `expected_tool`, or is listed in `acceptable_tools`; **0 points** otherwise (including no tool call, or a tool call that is not in the presented list). No partial credit for a correct second call.

Report:

- overall accuracy = points / 25
- accuracy per category (`read`, `write-prepare`, `commit`, `policy`, `ambiguous`), each as `correct / total`
- a per-prompt table: id, category, expected, actual first tool, pass/fail, and whether `expected_args_contains` matched (informational)

`docs/production_write_signoff.md` asks for the overall number and the `write-prepare`, `commit` and `policy` numbers.

## Runner

`pnpm evals` runs `evals/run.ts` (written separately; this README is its spec).

Live mode:

1. Starts (or connects to) the MCP server twice: once with `EXTENSIV_MCP_WRITES_ENABLED=false` and once with `true`, against the mock (`EXTENSIV_BASE_URL=http://127.0.0.1:4010`), and fetches the **real tool list** from each, including descriptions and input schemas. The evals therefore test the tool descriptions as shipped, not a hand-written copy.
2. For each prompt, presents the tool list matching `requires_writes_enabled` to a Claude model with a short system prompt ("You are an assistant for a 3PL using the Extensiv MCP server; use the tools to answer"), sends the prompt, and records the **first tool call** (name and arguments). The model's text is kept in the results file but not scored. No tool results are returned to the model; the run stops after the first call.
3. Writes `evals/results/<timestamp>.json` with one record per prompt: id, presented tool names, model, first tool name, arguments, model text, pass/fail.
4. Prints the report described above and exits non-zero if overall accuracy is below the threshold given with `--min-accuracy <0..1>` (default 0, so it only reports).

Replay mode: `pnpm evals --from-file results.json` re-scores an existing results file against the current `prompts.json` without calling a model. Use it after editing `expected_tool`, `acceptable_tools` or `expected_args_contains`, and to compare two runs.

Other flags the runner accepts: `--model <id>`, `--only E03,E12` (subset), `--writes-tool-list <path>` / `--read-tool-list <path>` (use saved tool lists instead of starting the server).

Command lines (Bash or Zsh):

```bash
pnpm evals
```

Expected last line of output:

```
overall 23/25 (0.92)  read 12/14  write-prepare 5/5  commit 2/2  policy 2/2  ambiguous 2/2
```

```bash
pnpm evals --from-file evals/results/2026-09-16T10-00-00Z.json
```

Expected last line of output: same format as above, prefixed with `replay`.

PowerShell:

```powershell
pnpm evals
pnpm evals --from-file evals\results\2026-09-16T10-00-00Z.json
```

Expected output: same as above.

The model needs an API key in the environment (`ANTHROPIC_API_KEY`); the runner refuses to start live mode without it and prints how to use `--from-file` instead.

## Adding prompts

Keep the id sequence, keep the fixture names, and cover a real phrasing (paste what someone actually typed, minus PII). Every write prompt needs `requires_writes_enabled: true`. When a new tool is added to the server, add at least one prompt for it and one prompt that is its closest confusable neighbour.
