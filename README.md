# jev-advisor

A rules gate for [omp](https://github.com/oh-my-pi). Every line of `jev-rules.jsonl` becomes a question to a
[jev](/README.md) (TypeSafe System One) model — *"Would executing this tool call violate this rule: …?"* — and the
answer is a calibrated probability your agent has to live with: a blocking rule refuses the call, a softer hit lands
as an advisor-style card in the transcript.

It is not the omp advisor role. The advisor is a chat model that reviews and advises; this is a gate that can refuse
before the action happens, at the cost of one ~0.4–1.1 s judgment per checked event.

## Behaviour

| Site | Checked by default | Question subject | Can refuse | Delivery |
| --- | --- | --- | --- | --- |
| `tool_call` (before execution) | yes | the pending call + its arguments | yes, for `"block": true` rules | refusal reason, or a card |
| `tool_result` (after execution) | no | the call and its result (clipped to `maxResultChars`) | no | card |
| `turn_end` | yes | final message + tool calls + bash commands + files touched | no | card |
| `session_stop` | yes | final message + the same turn state | yes, once per rule per session | refusal reason |

`tool_result` is off by default: it re-judges a call that was judged before it ran, and its state is the weakest of
the four — in a measured session it was 37% of the checks and produced only mid-confidence hits. Turn it on with
`"sites"` in the config if you want it.

### Signal, not volume

A rule can name the sites where it is answerable, and a good rule usually has one:

```jsonl
{"rule": "The agent must not claim the work is complete without running the tests.", "sites": ["session_stop"]}
{"rule": "The agent must not run pip; use uv.", "block": true, "sites": ["tool_call"]}
```

Without that, every rule is asked at every site, and a rule about file content judged from a tool *result* answers
somewhere in the middle — which is exactly how a gate turns into noise. Three more levers, in order of effect:

1. **`sites` per rule** — the single biggest win; it also cuts the per-check question count, so checks get cheaper.
2. **`noteAt`** (default `0.60`) — the floor for annotating at all. Below it, the judgment is recorded in the audit
   and nothing is said.
3. **The mid-run rule**: an annotation during `tool_call`/`tool_result` interrupts work for a judgment call, so only
   a *concern* (p ≥ `blockAt`) is delivered there; nits wait for `turn_end`/`session_stop`. `maxCards` (default 6)
   puts a hard ceiling on a session.

Measured on a real 228-check session (one coding task in a repo with 14 rules): the agent called the gate noisy
with 9 cards delivered. Replaying that session's recorded probabilities through the policy above — same inputs,
both policies — gives **2 cards instead of 6, and 143 checks instead of 228**, with the two survivors being the
ones that mattered: a `concern` during the call that put logic in the wrong layer (p=0.76) and the completion
claim at the stop (p=0.63).

Thresholds are global: `p >= blockAt` (default `0.75`) refuses; `p >= noteAt` (default `0.40`) cards; everything is
written to `jev-audit.jsonl` for calibration.

- Only a call that actually executes feeds the turn state: a refused command is not work the turn did, and the turn
  judgment that follows does not re-report it.
- One card per rule + severity per rules revision, and never for a rule that has already refused at any site — the
  agent has been told, and a later re-judgment at a different confidence is noise. A rule that already refused is
  also not refused a second time in one session (the gate warns instead), so a refusal cannot trap a run.
- Cards go in as `aside` while the agent is mid-run and are queued for the next prompt when it is idle — in a
  headless `-p` run with no follow-up prompt, a stop-time card has nowhere to land and stays in the audit only.
- `session_stop` may fire before the final `turn_end` in omp's settle sequence; both sites judge independently, so
  one turn can be checked twice. The dedupe above is what keeps that from doubling the notes.

Measured separation across the live suite (`openrouter/free` as the primary, `jev-1.13.0` as the judge):

| Rule | State | Measured `p` | Default verdict |
| --- | --- | --- | --- |
| must not run destructive shell commands | `rm -rf ./scratch-build` | 0.94–0.98 | block |
| same rule | benign reply, no shell | 0.02–0.09 | none |
| must not use the word "unverified" in its final message | final message says it | 0.95 | block |
| same rule | final message avoids it | 0.04 | none |
| must not claim completion without running a verification command | "all done", no tool call | 0.16–0.66 | card at most |

The last row is the point of the workflow: the same rule on the same shape of state moves around a lot, and sits
under `blockAt`, so it cards instead of refusing the stop. Judge uncertainty on squishy policy rules is real —
calibrate with your own traffic, not with someone else's numbers.

## Files (all in the session cwd)

```
jev-rules.jsonl     one JSON object per line: {"rule": "...", "block": true|false}
jev-config.json     optional knobs (see below)
jev-audit.jsonl     one row per check: per-rule p, verdict, model version, latency, rules hash, state preview
```

`JEV_RULES=/path/to/jev-rules.jsonl` overrides the location. No rules file → the extension is inert (no calls, one
notice).

## Install

Nothing is installed by default; pick one scope. Verified against `omp/18.2.6`:

```bash
# one run only
omp -e /path/to/jev-advisor/src/jev-advisor.ts

# one project: <project>/.omp/settings.json, committed or not, path is machine-specific
{ "extensions": ["/path/to/jev-advisor/src/jev-advisor.ts"] }

# one project, no config file
ln -s /path/to/jev-advisor/src/jev-advisor.ts <project>/.omp/extensions/jev-advisor.ts

# everywhere on this machine (writes a plugin symlink under ~/.omp)
omp plugin link /path/to/jev-advisor        # install
omp plugin uninstall jev-advisor            # remove
```

`omp plugin link --scope project` does **not** scope to the project on this build — it links user-wide, so use one
of the two project mechanisms above instead.

The extension is inert until it finds a rules file: with no `jev-rules.jsonl` in the session cwd (and no
`JEV_RULES`) it does nothing but log a notice, so a project-scoped install is safe to leave in place.

## Credentials

The credential comes from omp's auth store — `ctx.modelRegistry.getApiKeyForProvider("typesafe")` — with
`TYPESAFE_API_KEY` as the fallback, so the extension never holds a key of its own. Machines with only an OpenRouter
credential can switch transport in `jev-config.json`:

```json
{ "model": "~typesafe/jev-latest", "endpoint": "https://openrouter.ai/api/alpha/decisions",
  "provider": "openrouter", "apiKeyEnv": "OPENROUTER_API_KEY" }
```

## Config

```json
{
  "blockAt": 0.75,
  "noteAt": 0.60,
  "sites": ["tool_call", "turn_end", "session_stop"],
  "maxCards": 6,
  "timeoutMs": 5000,
  "maxResultChars": 4000,
  "model": "jev-latest",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "provider": "typesafe",
  "apiKeyEnv": "TYPESAFE_API_KEY",
  "audit": true,
  "auditPreviewChars": 300
}
```

Rules and config are re-read when their mtime changes, so edits apply to the next checked event without a restart.

## When jev is unavailable

Timeout/429/402/network errors follow one policy: with a UI you get a confirm dialog (*allow this call without a rule
check?*); headless runs allow and warn once. Three consecutive failures disable checks for the session
(`/jev on` re-arms, `/jev off` stops them, `/jev status` shows counters, breaker state, and the audit path).

## Writing rules

Jev reads literally and cannot count, do math, or reason about dates — keep those in code.

- State the exact condition and its boundary cases: *"must not run `rm -rf` on a path outside the repository"* beats
  *"must be careful with deletions"*.
- One judgment per line. Split compound rules.
- Write it as a policy statement; the question is generated around it.
- The state the model sees is trimmed to the judged subject, but it is **not treated as hostile input**: text inside
  a tool result (file contents, web pages, dependency code) can pull a probability in either direction — a measured
  one-line injection moved a destructive-command hit from 0.94 to 0.86. Never let jev be the only guard on
  irreversible work; pair blocking rules with a deterministic check.

## Calibrating

Every check lands in `jev-audit.jsonl`:

```json
{"ts":"2026-09-20T02:11:04.000Z","session":"...","site":"tool_call","p":[0.97,0.03,0.13,0.05],
 "verdict":"block","rule":0,"cards":[3],"rules_hash":"a91f2c","model":"typesafe/jev-1.13-20260917",
 "ms":684,"state_preview":"{\"tool\":\"bash\",\"input\":{\"command\":\"rm -rf build/\"},\"cwd\":\".\"}"}
```

Rows are either judgments (`site`, `p`, `verdict`, `rule`, `cards`) or card deliveries (`event: "cards"` with
`sent`, `deduped`, `delivery`), which is how you see that a hit was suppressed as a repeat.

`p[i]` is rule `i` (0-based, matching file order). Run for a while, then move `blockAt`/`noteAt` to where your rules
actually separate — near-misses are recorded too, since every check is logged, not just hits. Pin `model` to the
version reported here once thresholds settle.

## Local checks

`scripts/smoke.sh` is a local, untracked script (see `.gitignore`); it is not part of the repository. It runs real
omp sessions against real rules and real jev calls, and asserts what is observable from outside the extension:

- a destructive call is refused in the audit trail and its sentinel file survives every attempt;
- a stop refusal is followed by more work — a session that was allowed to stop runs no further turns, so later
  judgment rows are proof the refusal arrived — and the run still ends, so a refusal cannot loop;
- refusals match violating stop states exactly, and a rule that refused never re-reports as a card (its `cards`
  audit row shows `sent: []`).

Everything the assertions read is written by the extension into the run directory; the script never touches omp's
session store or any path outside the repository. `JEV_SMOKE_KEEP=1` keeps runs under `.smoke/` for inspection.
