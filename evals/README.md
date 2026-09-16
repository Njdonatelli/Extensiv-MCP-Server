# Tool-selection evals

`evals/prompts.json` holds 25 prompts that a 3PL ops person or account manager might type to an assistant connected to the Extensiv MCP server. Each prompt is scored on **which tool the model calls first**, nothing else. The prompts use the world that `packages/mock-extensiv/src/seed.ts` actually builds: customer **Acme Outdoor Co** (id 1, in the write allow-list, facilities LAX-1 and DFW-2), **Bluebird Cosmetics** (id 2), **Out Of Scope Co** (id 9, outside the write allow-list), SKUs `ACME-TENT-2P`, `ACME-STOVE-01`, `ACME-FILTER-SQZ` (lot tracked), orders `ACME-SO-100xx` (10021/10022 short, 10023 on hold, 10024 past its earliest ship date, 10026 open), and receipts `ACME-ASN-5003` (closed, with a receiving variance) and `ACME-ASN-5004` (open, due tomorrow). A correct tool call therefore returns real data against the mock, not a not-found.

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

Two programs, because scoring and model-driving are separate concerns.

### 1. `evals/drive_client.ts` — produce selections with a real MCP client

This drives **this repository's own server binary over MCP** with a real model, one fresh client session per prompt, and records the first tool the model chose. The tool descriptions and input schemas reach the model exactly as they will in production, because they come from the running server rather than a copy pasted into a prompt.

It shells out to the `claude` CLI in headless mode (`--output-format stream-json`), passing an `--mcp-config` that launches `packages/server/dist/cli.js` with the mock credentials and a private state directory per prompt. Prompts whose `requires_writes_enabled` is true get `EXTENSIV_MCP_WRITES_ENABLED=true` plus a write allow-list, so those sessions really are offered 16 tools and the others really are offered 11. The recorded `tools_offered` count per prompt proves which list was presented.

Runs are serial on purpose: a parallel burst would make rate limiting, not tool choice, the thing being measured.

Prerequisites, in order (Bash or Zsh):

```bash
pnpm install && pnpm build
```
Expected: no TypeScript errors.

```bash
pnpm --filter @mcp-3pl/mock-extensiv start
```
Expected output: `Mock Extensiv API listening on http://127.0.0.1:4010`. Leave this running in its own shell.

Then, in a second shell (Bash or Zsh):

```bash
npx tsx evals/drive_client.ts --out evals/results/selections.json --model claude-sonnet-5
```
Expected output: one line per prompt, `E01 [read-only, 11 tools] -> verify_connection`, ending with `25/25 prompts produced a tool call.`

PowerShell, same two steps:

```powershell
pnpm --filter @mcp-3pl/mock-extensiv start
```

```powershell
npx tsx evals/drive_client.ts --out evals/results/selections.json --model claude-sonnet-5
```

Flags: `--model <id>`, `--only E03,E12` for a subset, `--base <url>` to point at a different API, `--timeout-ms <n>` per prompt.

### 2. `evals/run.ts` — score

```bash
npx tsx evals/run.ts --from-file evals/results/selections.json
```
Expected output: the accuracy report, the miss list, and the path of the timestamped results file it wrote under `evals/results/`.

Add `--min-accuracy 0.9` to make it exit non-zero below a threshold, for CI.

`npx tsx evals/run.ts --dump-tools <path>` writes the exact tool list and system prompts an offline or third-party run should present, so a run can be reproduced without this repo's harness.

`evals/run.ts` also has an API-key live mode (`ANTHROPIC_API_KEY` plus the `@anthropic-ai/sdk`) that sends the tool list to the Messages API directly. It exists for environments without the `claude` CLI; the MCP-client driver above is the preferred path because it exercises the real transport.

### Reading the report

```
Tool-selection accuracy: 23/25 (92%)
  read           12/14
  write-prepare  5/5
  commit         2/2
  policy         2/2
  ambiguous      2/2

  MISS E05 expected find_stuck_orders got find_orders
results: evals/results/2026-09-16T10-00-00-000Z.json
```

The results file keeps every selection and its arguments, so a miss can be reviewed without re-running the model. `docs/production_write_signoff.md` asks for the overall number and the `write-prepare`, `commit` and `policy` numbers.


## Recorded runs

Four runs against the running server, model `claude-sonnet-5`, driven through the real MCP client. The selections and per-prompt trajectories are in `evals/results/`.

| Run | Selections file | First tool called | Expected tool reached | What changed before the run |
|---|---|---|---|---|
| 1 | `selections.json` | 11/25 (44%) | 23/25 (92%) | Baseline |
| 2 | `selections-v2.json` | 18/25 (72%) | 23/25 (92%) | `customer_id` and `facility_id` accept a name, not just an id |
| 3 | `selections-v3.json` | 19/25 (76%) | 23/25 (92%) | `order_id` on update and cancel accepts a reference number |
| 4 | `selections-v4.json` | 19/25 (76%) | 23/25 (92%) | After the adversarial-review fixes; confirms no regression |

Run 1 is the reason the two metrics exist. Task reach was already 92%, but the model spent its first call on `describe_scope` in twelve prompts, because every prompt names a customer the way an operator speaks while every tool demanded an id. That is a defect in the tool surface, not in the model, and it is invisible if you only measure whether the right tool was eventually used. Accepting names closed most of the gap; accepting order reference numbers closed more.

The remaining six imperfect prompts are worth reading rather than optimising away:

- **E02** calls `verify_connection` before `describe_scope`. The prompt asks both "what can you see" and "may you change anything", so checking the connection first is defensible.
- **E13, E14, E15** look the order or the SKUs up before preparing a write. That is prudence before a mutation, and the trajectory still reaches the right tool.
- **E22** (writes disabled, asked to create an ASN) calls no tool at all and explains that writes are off. Arguably the better answer; the expectation of `find_receipts` is the debatable part, and it is left as written rather than relaxed to flatter the score.
- **E25** (write for a customer outside the write allow-list) calls `describe_scope` and then explains. The eval expects `create_order` so that the server's own refusal reaches the operator. A model that pre-empts the policy is not wrong, but it hides the server's message.

Neither miss was "fixed" by editing the expectation. Two expectations that are genuinely arguable are recorded here instead.

## Adding prompts

Keep the id sequence, keep the fixture names, and cover a real phrasing (paste what someone actually typed, minus PII). Every write prompt needs `requires_writes_enabled: true`. When a new tool is added to the server, add at least one prompt for it and one prompt that is its closest confusable neighbour.
