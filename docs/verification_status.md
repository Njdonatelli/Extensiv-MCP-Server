# Verification status

What is actually proven about this server, and what is still waiting on real Extensiv credentials. Nothing below is claimed on the strength of the code "looking right": every row in the verified table names the command or test that demonstrates it.

**Bottom line.** The server, the core, the adapter and the webhook receiver are verified end to end against a local mock of the Extensiv REST API that was written from Extensiv's public documentation. **No call has ever been made to a real Extensiv tenant.** Everything in the "waits on credentials" table is a claim about Extensiv's behaviour that our mock currently asserts on Extensiv's behalf.

- Commit: `<<COMMIT>>`
- Test suite: `<<TESTCOUNTS>>`
- Eval suite: `<<EVALS>>`
- Mock fidelity table: [`packages/mock-extensiv/MOCK_FIDELITY.md`](../packages/mock-extensiv/MOCK_FIDELITY.md)

---

## 1. Verified against the mock

| # | Claim | How it is verified |
|---|---|---|
| <<V>> | | |

## 2. Verified by construction or inspection only

| Claim | Why there is no test | Risk if wrong |
|---|---|---|
| <<I>> | | |

## 3. Waits on real credentials

Each row is a statement our mock makes about Extensiv that only a real tenant can confirm. The "first check" column is what to run on day one with sandbox or production credentials; the "falsified if" column is what a wrong answer looks like, so nobody has to guess whether the run passed.

| # | Assumption the mock encodes | Source or gap | First check with credentials | Falsified if |
|---|---|---|---|---|
| <<W>> | | | | |

---

## 4. Switching to the real API

One value: `EXTENSIV_BASE_URL`. The token URL is derived from it unless `EXTENSIV_AUTH_URL` is set. Nothing else in the configuration changes shape between the mock, a sandbox and production.

A change prepared against one base URL cannot be committed against another: the engine stores the target with the change and refuses a cross-environment commit. A `change_id` created while pointed at the mock can therefore never fire against production.

Recommended order when credentials arrive:

1. `extensiv-mcp --check` with writes off. Confirms auth, the environment label, and how many customers and facilities the credential can actually see.
2. Read-only soak: leave `EXTENSIV_MCP_WRITES_ENABLED` unset and use the read tools against real data. Compare a handful of orders and stock positions with the 3PLWM UI. This is where mapping mistakes surface.
3. Work the table in section 3 top to bottom, recording the answers in `MOCK_FIDELITY.md`.
4. Only then complete [`production_write_signoff.md`](production_write_signoff.md) and turn writes on for one customer.

## 5. Known guesses

The mock flags every invented behaviour in code (`// GUESS:`) and tabulates them in `MOCK_FIDELITY.md`. The adapter flags every property name it inferred (`// INFERRED:`) and lists them in its README. Those two lists are the re-verification backlog; section 3 is the subset that would change behaviour rather than just wording.
