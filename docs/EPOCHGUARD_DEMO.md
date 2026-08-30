# EpochGuard Reproducible Demo Runbook

This runbook reproduces the two fixed EpochGuard worlds without treating a
deterministic test double as a real model. It is written for a judge, reviewer,
or recording operator starting from a clean machine state.

> [!IMPORTANT]
> **Evidence boundary:** a pre-freeze WSL2 working-tree snapshot passed its
> then-current offline gate, scratch preflight, and one seven-Run ModelArk API
> story on 2026-08-30. That is historical evidence, not certification of a later
> commit. This runbook never pre-declares Formal Demo `GO`; the exact clean
> public SHA and every result must be recorded outside the repository in the
> sanitized release manifest after the unchanged candidate passes each gate.

## 1. Know what one complete take means

One complete take uses:

- one clean WSL clone with Linux-owned `node_modules`;
- one disposable live Ark/Codex credential smoke outside product state;
- one newly created EpochGuard data root for the take;
- three real Normal Agent Runs;
- three real Impossible Agent Runs;
- one real Budget refresh Run; and
- one edited/accelerated video assembled from that truthful seven-Run product
  story.

The credential smoke is a separate model call and is not counted among the
seven EpochGuard Agent Runs. It exists to prevent a failed credential attempt
from consuming a scenario's one-shot World.

Normal and Impossible are independent partitions inside the same fresh take:

```text
APP_DATA_DIR/
  launchpad.json
  epochguard-normal.json
  epochguard-impossible.json
```

The two scenario Stores share the three fixed Role Agent identities through
`DualScenarioEpochGuardService`, but they do not share World history, Receipts,
Sessions, Permits, or Effects. A new overall data root makes both partition
files pristine. Do not reuse that root for another rehearsal or recording.

### One business scenario, two controlled states

The formal story is **one campaign-publish decision**: inventory, budget, and
policy must all authorize the same immutable action before it can create a
protected Effect. Normal World is the healthy control for that scenario;
Impossible World is its controlled temporal-conflict and recovery branch. They
are intentionally separate fixture partitions, not consecutive revisions of
one Store. Say this explicitly in the narration rather than presenting seven
Runs as two unrelated product demos.

### Official Track 1 acceptance map

The current source of truth is the
[official Track 1 information document](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc),
the [Devpost overview](https://tiktoktechjam2026.devpost.com/), and the
[Official Rules](https://tiktoktechjam2026.devpost.com/rules). The public
three-minute video is a hard release artifact, not a substitute for a working
frontend-to-Agent path.

| Official requirement | What the formal recording must show | EpochGuard evidence |
| --- | --- | --- |
| Create or select a runnable Agent and show lifecycle state | Start on the Session Safety launcher, focus the Budget Role card, and show its real Agent name, ID, fixed profile, and `ready` state before Run | Focus is a read-only selection, not owner assignment; frontend independently resolves the complete pre-provisioned trio and the server freezes their IDs |
| Invoke through the Playground with a real task | Keep the `Playground · Inspect and operate one protected Session` header and click the real scenario button | One campaign action fans out to three real Codex/ModelArk Runs |
| Show a real model/file/tool/sandbox/data/infrastructure action | Keep `Authoritative runtime evidence` visible, then follow the focused Budget Agent into its same-name Role card and expand that card's `Run-bound evidence` panel | Server verifies the card preserves the frozen Budget Agent ID; Runtime strip supplies 3/3 Run/Thread and token-usage coverage; details supply Run/Assignment/Thread, source revision, Runtime label, and server-written Pack path/hash |
| Demonstrate middleware behavior and proof | Show current Snapshot, interval table, Gate, proof, Permit/Effect state | Backend verdict recomputation, joint-validity intersection, no-cut witness, and Effect Gate |
| Show one appropriate failure, denial, degradation, abuse, or recovery path | EpochGuard chooses temporal conflict + denial + recovery: Impossible World, then `Re-observe Budget only` | Three locally correct `ALLOW` decisions still produce no cut/effect; only Budget reruns; final current `DENY` remains blocked |
| End understandable and controllable | Finish on Gate `LOCKED`, `RESOLVED SAFELY · NOT RELEASED`, the three cards at `1 run / 2 runs / 1 run`, and effect 0 | Authoritative session state is `CONSISTENT_DENY`; the visible platform explains the conflict and reaches a terminal safe state without forcing success |

The Dashboard is only the evidence and control surface. The middleware claim
comes from the trusted server/Runtime/data/effect path; visual polish alone is
not evidence of middleware behavior.

> [!WARNING]
> The literal selection is only the Role card's read-only Agent focus. Do not
> narrate it as choosing, replacing, or editing an owner. Candidate acceptance
> must prove that focus never enters the create payload, while the subsequently
> displayed Budget Run remains bound to the same server-frozen Agent identity.

## 2. Prepare a clean WSL2 checkout

The recommended release environment is WSL2 Ubuntu 24.04 with Node.js 22+ and
npm 10+. Clone into the WSL Linux filesystem (for example `~/src`), not a
Windows-mounted directory. Never share `node_modules` between Windows and WSL.

```bash
mkdir -p ~/src
cd ~/src
git clone --branch epochguard/staging --single-branch https://github.com/dong-runze/epochguard.git
cd epochguard

test "$(git branch --show-current)" = "epochguard/staging"
test -z "$(git status --short)"
export EPOCHGUARD_CANDIDATE_SHA="$(git rev-parse HEAD)"
test "$EPOCHGUARD_CANDIDATE_SHA" = "$(git rev-parse origin/epochguard/staging)"
node --version
npm --version

npm ci
npm run check
```

Required deterministic result:

```text
All discovered Server and Web test files pass.
All Server and Web tests pass with zero skipped/only cases.
Web typecheck/build: pass
Server typecheck/build: pass
```

Do not copy historical test counts into a final claim. Record the exact output
from this frozen SHA in the external manifest after the command finishes.

These tests use deterministic fixtures and controlled runners. They do not
validate Ark credentials or remote model behavior. They deliberately run before
any secret enters the shell.

### Freeze the exact candidate before recording

A formal take is tied to one public Git commit. The operator must record all of
the following before any credential preflight or product Run:

```text
branch              epochguard/staging
candidateSha        full 40-character SHA
remoteSha           exact same SHA
gitStatusClean      true
nodeVersion         exact version
npmVersion          exact version
codexVersion        codex-cli 0.111.0
runtime             WSL2 Ubuntu 24.04 / local-process
model               endpoint/model ID only; never the API key
baseHost            ark.ap-southeast.bytepluses.com
offlineGate         npm run check PASS
```

Hard rules:

- `git branch --show-current` must be `epochguard/staging`, `git status --short`
  must be empty, and the local SHA must equal `origin/epochguard/staging`. A
  working tree that merely passed tests is not a candidate.
- The same SHA must be used for `npm run check`, credential preflight, the full
  browser take, screenshots, architecture, narration claims, and uploaded code.
- Freeze features once the take begins. Any code or behavior change creates a
  new candidate and invalidates earlier release evidence.
- Keep the full manifest locally; show only the short SHA, runtime, model label,
  and pass/fail badge on screen. Never show environment dumps.

The repository intentionally contains no mutable `current GO` claim or embedded
candidate SHA. Git commit hashes cannot be self-recorded inside the commit that
they identify, and updating this file after live validation would invalidate
the same-SHA evidence. Record candidate identity and results in the external
sanitized manifest, then fast-forward the public submission branch or attach an
immutable public tag to that unchanged commit.

Install and resolve the pinned Linux Codex CLI only after the offline gate:

```bash
npm install --global @openai/codex@0.111.0
export CODEX_BIN="$(npm prefix --global)/bin/codex"
case "$CODEX_BIN" in /*) ;; *) echo "CODEX_BIN must be an absolute Linux path"; exit 2;; esac
test -x "$CODEX_BIN"
"$CODEX_BIN" --version
```

The public candidate reference for this protocol is `epochguard/staging`; the
older default `main` branch is not the candidate. Devpost, the external manifest,
and every reviewer command must name the staging branch and its exact SHA. If an
immutable submission tag or promoted default branch replaces it, update every
public link together and repeat the same-SHA gates.

Use `"$CODEX_BIN"` for every later invocation. Do not switch to
`command -v codex` or bare `codex`: an inherited Windows PATH can shadow the
Linux global install with an incompatible Windows shim. The expected version
line is `codex-cli 0.111.0`.

Only now set Ark configuration explicitly in this shell. The production server
reads `process.env`; it does not load `.env`. If a key is not available, stop
here: the deterministic candidate remains testable, while the real preflight
and seven product Runs remain open.

```bash
read -rsp "ARK_API_KEY: " ARK_API_KEY; echo
export ARK_API_KEY

read -rp "ARK_MODEL (Responses-capable endpoint/model ID): " ARK_MODEL
export ARK_MODEL

export ARK_BASE_URL="https://ark.ap-southeast.bytepluses.com/api/v3"

case "$ARK_API_KEY" in
  ""|replace-*|*'<'*|*'>'*) echo "Real ARK_API_KEY required"; exit 2 ;;
esac
case "$ARK_MODEL" in
  ""|*replace-*|*'<'*|*'>'*) echo "Real ARK_MODEL required"; exit 2 ;;
esac
```

## 3. Live credential preflight (required)

Do not use `arkConfigured: true` as a credential test. That field only checks
that `ARK_API_KEY` and `ARK_MODEL` are non-placeholder strings. The following
smoke uses the same generated Codex provider configuration as the app, but a
separate scratch `CODEX_HOME` and work directory. It does not create an
EpochGuard Session or write either scenario Store.

`npm run check` in the previous section must finish first because this command
imports the built server configuration module.

```bash
umask 077
export EPOCHGUARD_PREFLIGHT_ROOT="$(mktemp -d /tmp/epochguard-preflight.XXXXXX)"
export CODEX_HOME="$EPOCHGUARD_PREFLIGHT_ROOT/codex-home"
mkdir -p "$CODEX_HOME" "$EPOCHGUARD_PREFLIGHT_ROOT/work"

node --input-type=module -e \
  'import { loadConfig, writeCodexConfig } from "./apps/server/dist/config.js"; await writeCodexConfig(loadConfig());' \
  || { echo "Could not generate the scratch Codex configuration" >&2; exit 2; }

set -o pipefail

timeout --foreground 180s "$CODEX_BIN" exec \
  --ephemeral \
  --json \
  -o "$EPOCHGUARD_PREFLIGHT_ROOT/final.txt" \
  --sandbox read-only \
  --skip-git-repo-check \
  -C "$EPOCHGUARD_PREFLIGHT_ROOT/work" \
  'Reply exactly EPOCHGUARD_PREFLIGHT_OK.' \
  | tee "$EPOCHGUARD_PREFLIGHT_ROOT/codex.jsonl"

preflight_status=("${PIPESTATUS[@]}")
if [ "${preflight_status[0]}" -ne 0 ]; then
  echo "Codex preflight exited ${preflight_status[0]}" >&2
  exit "${preflight_status[0]}"
fi
if [ "${preflight_status[1]}" -ne 0 ]; then
  echo "Could not preserve the JSONL audit stream" >&2
  exit 4
fi

if ! PREFLIGHT_FINAL="$EPOCHGUARD_PREFLIGHT_ROOT/final.txt" \
  node --input-type=module -e \
  'import { readFileSync } from "node:fs";
   const value = readFileSync(process.env.PREFLIGHT_FINAL, "utf8").trim();
   if (value !== "EPOCHGUARD_PREFLIGHT_OK") {
     console.error("Final agent message did not exactly match the preflight marker");
     process.exit(3);
   }'; then
  exit 3
fi

echo "LIVE ARK/CODEX PREFLIGHT PASSED"
export EPOCHGUARD_LIVE_PREFLIGHT_SHA="$EPOCHGUARD_CANDIDATE_SHA"
```

This fail-closed check is pinned to `@openai/codex@0.111.0` and depends on
that version's `--ephemeral` non-persistence mode, `--json` JSONL stream, and
`-o/--output-last-message` final assistant-message file. Re-audit these output
contracts before changing the Codex version. The private scratch JSONL and final
file exist only for local review; arbitrary stream text is never accepted as the
success marker. Confirm they contain no secret, retain only a sanitized pass/fail
note or screenshot, then remove the entire scratch root after the take. Never
attach the raw scratch files to a submission, issue, chat, or commit.

Treat any nonzero exit, timeout, authentication error, endpoint/model error, or
missing marker as a failed release preflight. Fix credentials or the endpoint
and repeat only in scratch state. Do **not** create the demo data root or click a
scenario button until this command succeeds.

Why this is mandatory: the product create route intentionally returns `201`
after persisting `DISPATCHING`, while model work continues in the background.
With missing or invalid Ark access, a click can therefore return a Session
first, then transition it to `FAILED`. The fixture World has already been
written, so that data root is no longer a fresh demo take.

## 4. Start one fresh production single-port take

After the live preflight passes, replace the scratch `CODEX_HOME` with a newly
created product root. Keep this root for both scenarios in this one take. The
formal path serves the built Web app and API from one production server; it is
not the two-process Vite development path.

```bash
export EPOCHGUARD_DEMO_ROOT="$(mktemp -d /tmp/epochguard-demo.XXXXXX)"
export APP_DATA_DIR="$EPOCHGUARD_DEMO_ROOT/data"
export AGENT_WORKSPACE_ROOT="$EPOCHGUARD_DEMO_ROOT/workspaces"
export CODEX_HOME="$EPOCHGUARD_DEMO_ROOT/codex-home"
mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"

export APP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
export EPOCHGUARD_TAKE_INDEX="${EPOCHGUARD_TAKE_INDEX:-1}"
case "$EPOCHGUARD_TAKE_INDEX" in 1|2|3|4|5|6) ;; *) echo "Take index must be 1..6"; exit 2;; esac
export NODE_ENV=production
export HOST=127.0.0.1
export PORT="$((3100 + EPOCHGUARD_TAKE_INDEX))"
export RUNTIME_PROVIDER=local-process
export CODEX_SANDBOX_MODE=workspace-write

test "${#APP_AUTH_TOKEN}" -ge 24
case "$APP_AUTH_TOKEN" in *[!A-Za-z0-9._~-]*) echo "Token is not URL-safe"; exit 2;; esac
git fetch --quiet origin refs/heads/epochguard/staging:refs/remotes/origin/epochguard/staging
test -z "$(git status --short)"
test "$(git branch --show-current)" = "epochguard/staging"
test "$(git rev-parse HEAD)" = "$EPOCHGUARD_CANDIDATE_SHA"
test "$EPOCHGUARD_LIVE_PREFLIGHT_SHA" = "$EPOCHGUARD_CANDIDATE_SHA"
test "$EPOCHGUARD_CANDIDATE_SHA" = "$(git rev-parse origin/epochguard/staging)"

# WSL can copy the token to the Windows clipboard without printing it.
printf %s "$APP_AUTH_TOKEN" | clip.exe

npm start
```

The shell exports are the configuration. Creating `.env` is not sufficient:
the production server reads the explicit `process.env`. `npm run check` must
have built both `apps/web/dist` and `apps/server/dist` before `npm start`.

Wait for the one production server, then open:

```text
Web UI and API: http://127.0.0.1:3101
```

The example URL is take 1. Rehearsal takes 1–5 use ports 3101–3105; an optional
separate final capture may use take index 6 / port 3106. All five rehearsals use
the one already verified public fresh clone and unchanged candidate SHA. Each
take creates a new product data/workspace/Codex root and uses a distinct browser
origin, so cached credentials and saved Session pointers cannot leak between
takes.

Open the Web UI, paste `APP_AUTH_TOKEN` into **Enter the access token**, and
select **Open Launchpad**. Clear the clipboard immediately after login
(`printf '' | clip.exe`) and before recording. Before clicking a scenario:

- confirm the **Runtime configuration needed** banner is absent;
- confirm the Runtime card reports the intended Ark model and an available
  Codex Runtime; and
- retain the successful scratch preflight as the actual credential evidence.

The app initializes exactly three fixed Role Agents. The UI resolves them by
exact name and hides them from the Agent Chat sidebar. Click **Budget** once to
focus its read-only inspection and verify the real fixed Agent name, full Agent
ID, lifecycle, expected profile, and evidence scope. This focus does not choose
an owner or enter the create request. Do not create, replace, edit, stop, delete,
or manually prompt these protected Agents through Agent Chat.

## 5. Run the seven-model-call story

### Normal World — Runs 1 to 3

1. Select **Session Safety** in the top workspace switcher.
2. Confirm the launcher lists the fixed Inventory, Budget, and Policy Role
   Agents. Click **Budget** and record its real name, full Agent ID, lifecycle,
   expected profile, and evidence scope. This read-only focus does not change
   the server-frozen assignments.
3. Select **Normal World**.
4. Click **`Run Normal World`** exactly once.
5. Observe the initial `201`/`DISPATCHING` Snapshot, then queued/running Role
   Attempts. Wait for all three real Agent cards to show their own Run evidence.
   The Budget card should remain highlighted and its `Run-bound evidence` should
   open; verify it carries the same full Budget Agent ID shown before Run.
6. Confirm the authoritative result:

   ```text
   Team Decisions: 3/3, 3 ALLOW
   World head: v10
   Observed-World Cut: VALID CURRENT
   Gate: READY
   Effects in this session: 0
   ```

7. If the Dashboard says `CONCURRENT`, open Run-bound evidence and confirm the
   actual Run intervals overlap. If it says `SEQUENTIAL_FALLBACK`, describe it
   that way; do not narrate it as parallel.
8. Click **`Commit protected effect`** once.
9. Confirm `RELEASED`, one Effect ID, and
   **`Effects in this session: 1`**. A repeated Commit is idempotent, but it is
   not needed in the primary recording.
10. Click **`Clear saved session`** after the Session is terminal.

`Clear saved session` only removes the browser's saved resumability pointer. It
does not reset `epochguard-normal.json`; clicking `Run Normal World` again in
this root will fail with `UNSTABLE_WORLD`.

### Impossible World — Runs 4 to 6

1. Select **Impossible World**.
2. Click **`Run Impossible World`** exactly once.
3. Wait for the three real Role Runs and preserve all three local `ALLOW` cards
   on screen.
4. Confirm the server-projected result:

   ```text
   Inventory ALLOW [18, ∞)
   Budget    ALLOW [19, 20)
   Policy    ALLOW [21, ∞)

   L = 21
   U = 20
   NO VALID OBSERVED-WORLD CUT
   conflict witness = old Budget × permitted Policy
   Effects in this session: 0
   ```

5. Open **Raw server proof** long enough to show that the witness and bounds
   are server data. Do not suggest that the browser recomputed them.
6. Confirm the authorized next step identifies Budget and reports two
   unnecessary reruns avoided.

### Budget recovery — Run 7

1. Click **`Re-observe Budget only`** once.
2. Keep Inventory and Policy at run count 1 while Budget shows a distinct
   in-flight Attempt and then run count 2.
3. Confirm the new Budget evidence is `$0 [20,∞)` and its verdict is `DENY`.
4. Confirm the final authoritative result:

   ```text
   Team Decisions: 2 ALLOW + 1 DENY
   Observed-World Cut: VALID CURRENT at v21
   Session: CONSISTENT_DENY
   Effect Gate: RESOLVED SAFELY / NOT RELEASED
   Inventory/Budget/Policy run counts: 1/2/1
   Effects in this session: 0
   ```

This is successful recovery: the team now has one current, explainable world
and safely denies the action. Recovery does not mean forcing a publish.

## 6. Evidence checklist

For the final candidate, retain evidence without committing secrets, data
Stores, workspaces, Codex sessions, or raw sensitive output.

| Gate | Evidence to observe | Pass condition |
| --- | --- | --- |
| Candidate | Git revision and clean status | Recording and tests use the same final candidate |
| Deterministic | exact `npm run check` output | all discovered tests pass with zero skipped/only cases; both typechecks and production builds pass |
| Agent focus | Budget inspection before Run + focused Budget evidence after Run | same full Agent ID/profile identity; focus is absent from the create payload and assignments are unchanged |
| Credential | Scratch Codex JSONL + final-message file | real Ark/Codex call exits 0 and the trimmed final assistant message exactly equals the marker |
| Normal Runs | Dashboard Run/Assignment/Receipt evidence | three distinct real Runs, current 3-ALLOW result |
| Normal Effect | Gate and Effect ID | one Effect in the Normal Session |
| Impossible Runs | three cards + proof | three `ALLOW`, `L=21`, `U=20`, Budget × Policy witness, zero Effects |
| Selective refresh | in-flight/active separation and run counts | only Budget runs again; counts `1/2/1` |
| Recovered result | final Snapshot | current `CONSISTENT_DENY`, zero Effects |
| Runtime truth | coordination mode and timestamps | narration matches measured `CONCURRENT` or `SEQUENTIAL_FALLBACK` |

Do not expose `ARK_API_KEY`, `APP_AUTH_TOKEN`, environment dumps, absolute
workspace paths, full prompts, or unsanitized model output in a screenshot,
video, issue, or commit.

Keep a private, non-repository release-evidence directory for the final
candidate. A sanitized manifest should contain facts and hashes, not raw model
output or secrets:

```yaml
candidate:
  sha: <40-char public commit>
  upstreamSha: <same 40-char public commit>
  gitStatusClean: <true only after verification>
recordedAtSgt: <ISO-8601 after the gates run>
environment:
  os: WSL2 Ubuntu 24.04
  node: <version>
  npm: <version>
  codex: 0.111.0
  runtime: local-process
  model: seed-2-0-lite-260428
  baseHost: ark.ap-southeast.bytepluses.com
gates:
  npmRunCheck: <PASS|FAIL after this candidate runs>
  livePreflight: <PASS|FAIL after this candidate runs>
  agentFocusContinuity: <PASS|FAIL after browser inspection>
  browserSevenRunTake: <PASS|FAIL after this candidate runs>
normal:
  validation: VALID_CURRENT_ALLOW
  effectCountAfterCommit: 1
  effectCountAfterDuplicateCommit: 1
impossible:
  firstValidation: NO_VALID_OBSERVED_WORLD_CUT
  bounds: { lower: 21, upper: 20 }
  effectCount: 0
recovery:
  refreshedRole: budget
  runCounts: { inventory: 1, budget: 2, policy: 1 }
  validation: CONSISTENT_DENY
  effectCount: 0
rehearsals:
  attempted: <5 after all five takes finish>
  passedWithoutIntervention: <measured 0..5>
  ports: [3101, 3102, 3103, 3104, 3105]
privacy:
  trackedTree: <PASS|FAIL>
  gitHistory: <PASS|FAIL>
  retainedRawLogs: <PASS|FAIL>
  screenshots: <PASS|FAIL>
  video: <PASS|FAIL>
video:
  durationSeconds: <under 180>
  sha256: <local exported-file hash>
  publicYoutubeUrl: <final URL>
links:
  anonymousQa: <PASS|FAIL after logged-out checks>
reviewerAccess:
  offlineCheckNeedsSecret: false
  liveModelMode: <reviewer-owned eligible account|organizer-arranged temporary access>
```

Retain separately: the sanitized `npm run check` summary, candidate SHA, one
launcher screenshot, one Normal Effect screenshot, one no-cut screenshot, one
recovery screenshot, the master recording, final export hash, and the public
YouTube URL. Do not retain or submit raw preflight JSONL unless it has been
manually audited and redacted.

## 7. Execute the formal demo and produce the submission video

Seven real product Runs plus the required preflight are not guaranteed to
finish live within three minutes. Record the actual candidate first, then make
an edited/accelerated `2:50–2:55` video. Label speed-ups or jump cuts, preserve
real IDs and elapsed times around each cut, and never replace a wait with Mock
Preview footage.

### 7.1 Operator, screen, and privacy setup

- Preferred roles are Operator, Narrator, and Evidence Reviewer. One person may
  cover all three, but must use the same checklist.
- Record at 1920×1080, browser zoom 100%, English UI, large enough text to read
  the short IDs, and no unrelated tabs, bookmarks, notifications, clocks, or
  personal account details in frame.
- Use English narration or complete English subtitles. Do not rely on Chinese
  subtitles alone because the official materials must be English or include a
  complete English translation.
- Start with DevTools closed. Keep terminals out of the main product footage;
  show a sanitized candidate/preflight card or tightly cropped pass summary,
  never shell history or an environment dump.
- Copy `APP_AUTH_TOKEN` through the clipboard before capture, complete login,
  clear the clipboard, then begin recording. Never record the token entry,
  password manager, ModelArk console, the external credential source, `.env`,
  browser storage, or network authorization headers.
- Disable sleep, confirm at least 5 GB free disk, connect power, close chat and
  mail apps, and rehearse the exact pointer path once on a throwaway data root.

### 7.2 Pre-take Go/No-Go

Every row is mandatory. If any GO condition is false, stop before consuming the
one-shot fixture. Record the measured result in the external sanitized manifest;
do not edit this repository merely to turn a live status cell from red to green.

| Gate | GO condition | External manifest field |
| --- | --- | --- |
| Public candidate identity | branch is `epochguard/staging`; tree is clean; local SHA equals `origin/epochguard/staging`; Devpost/manifest name that exact public ref and SHA | `candidate.*` |
| Offline release gate | one public fresh clone completes `npm ci` and `npm run check` before any live take | `gates.npmRunCheck` plus exact retained output |
| Live credential gate | same-SHA disposable preflight succeeds without exposing the key | `gates.livePreflight` |
| Product story | same-SHA seven real Runs yield the documented outcomes | `normal`, `impossible`, `recovery` |
| Literal frontend Agent selection | operator focuses Budget and sees its real ID/lifecycle/profile; same ID continues into Run-bound evidence; assignments/create payload remain frozen | `gates.agentFocusContinuity` |
| Browser journey | launcher → Normal → commit → Impossible → Budget refresh completes in a fresh root | `gates.browserSevenRunTake` |
| Repeatability | at least 4 of 5 unchanged-candidate, fresh-product-root, distinct-origin takes pass without intervention | `rehearsals.*` |
| Evidence privacy | tracked tree, full Git history, retained raw logs, screenshots, and video are scanned separately | `privacy.*` |
| Submission assets | English copy, public repo, one-page architecture, public YouTube under 3:00, and testing instructions all name the same candidate | `video.*`, `links.*` |
| Devpost draft | exact form fields are saved and every public link reopens anonymously | `links.anonymousQa` |

For the five formal rehearsals, first use one public fresh clone of the frozen
SHA for `npm ci && npm run check` and one same-SHA scratch live preflight. Keep
that clean checkout unchanged. Then repeat section 4 with five new product
data/workspace/Codex roots and ports 3101–3105, using
`NODE_ENV=production HOST=127.0.0.1 PORT=310N RUNTIME_PROVIDER=local-process npm start`.
Do not rerun preflight merely to manufacture five successes, and do not call
`npm run dev` a formal rehearsal. Log pass/fail and the first failure cause for
every take; release requires at least four uninterrupted full journeys.

The architecture SVG and deterministic tests can be prepared ahead of the
model take. Do not record a final video or publish claims from an unclean tree.

### 7.3 Capture one truthful product take

1. Start the app with the fresh root from section 4 and complete browser auth
   before capture.
2. Open `Session Safety`. Record the launcher with all three exact protected
   Role Agent names and `ready` lifecycle states. Click **Budget**, read its real
   full Agent ID, lifecycle, expected profile, and evidence scope, and say that
   focus does not choose or replace an owner; server-frozen assignments stay
   unchanged. Do not create a disposable chat Agent just for the video.
3. Keep the Playground header visible, select Normal, and click its real Run
   button. Let all three Runs finish before capturing the evidence panels.
4. Keep the highlighted Budget card in view and expand its `Run-bound evidence`
   panel long enough to match the full Budget Agent ID from the launcher and read
   a Run ID, Thread, Assignment, Receipt, Evidence Pack path/hash, Runtime, and
   source revision.
5. Capture Protected Effect `READY` (backend Session
   `READY_AT_CURRENT_HEAD`), click **`Commit protected effect`** once, and
   capture one Effect. Retain the
   deterministic/API duplicate-Commit proof that the count remains one; do not
   spend video time or invent a second UI action if the released view no longer
   offers the button.
6. Clear only the saved browser pointer for the terminal Session, choose
   Impossible, and start the second controlled state in the same fresh overall
   data root.
7. Capture all three `ALLOW` cards together with `L=21`, `U=20`, canonical
   Budget × Policy witness, Gate locked, and effect count zero.
8. Capture the server-selected refresh plan, click `Re-observe Budget only`, and
   wait for the seventh real Run. Finish on Budget `DENY`; the three cards at
   `1 run / 2 runs / 1 run`; Gate `LOCKED`;
   `RESOLVED SAFELY · NOT RELEASED`; and effect zero. The authoritative backend
   Session state is `CONSISTENT_DENY`, even though the UI does not display that
   raw underscore token as its main label.
9. Stop capture only after the final Snapshot is settled. Preserve the raw
   master locally; do not reuse the data root for a retake.

If any evidence or narration fact is wrong, abandon the take and use a new data
root after fixing the cause. Do not edit Store files, splice outcomes from two
different candidates, or replay a used fixture as though it were fresh.

### 7.4 Final 2:55 edit and exact narration spine

| Target time | Evidence on screen | Narration |
| ---: | --- | --- |
| 0:00–0:10 | Hook, project name, short candidate SHA, sanitized preflight/check badges | “Every Agent can be right. The team can still act on a world that never existed.” |
| 0:10–0:23 | Session Safety inside Playground; focus Budget; its real ID/profile and all three `ready` states remain visible; Normal selected | “I can inspect the real Budget specialist here. The three evidence owners are pre-provisioned and server-frozen, so this UI focus cannot replace them.” |
| 0:23–0:45 | Click `Run Normal World`; labeled accelerated wait; `Unique active runs 3/3` and `Threads recorded 3/3` | “Three separate Role-Agent Codex Runs work in dedicated workspaces under the local-process Runtime. Each receives a server-issued Evidence Pack and returns an untrusted decision.” |
| 0:45–0:58 | Focused Budget card plus its expanded `Run-bound evidence`, matching Agent ID and concrete Run ID; Protected Effect `READY`; click `Commit protected effect`; Effect count 1 | “The same Budget identity now carries real Run-bound evidence. The backend binds Run, Receipt and version, recomputes our three fixed rules, and releases exactly one local Effect.” |
| 0:58–1:08 | Clear saved pointer; Impossible selected and started | “Now the same business decision enters a controlled temporal-conflict state in its separate pristine fixture.” |
| 1:08–1:31 | Labeled accelerated wait; three real Runs and three `ALLOW` cards | “Each local answer matches its authoritative fixture rule, but local correctness is not joint validity.” |
| 1:31–1:56 | No-cut panel, intervals, `L=21`, `U=20`, Budget × Policy witness, effect 0 | “These observations never coexist. The trusted backend produces a checkable counterexample and blocks the effect.” |
| 1:56–2:10 | `Raw server proof`, Run-bound evidence and Gate on the same Snapshot revision | “This Dashboard only renders one server Snapshot; it neither calculates safety nor releases effects.” |
| 2:10–2:32 | Server plan says Budget only; click refresh; labeled accelerated seventh Run | “The conflict witness preserves two valid Runs and re-observes only the invalid evidence owner.” |
| 2:32–2:47 | Budget `DENY`; cards show `1 run / 2 runs / 1 run`; Gate `LOCKED`; `RESOLVED SAFELY · NOT RELEASED`; effect 0 | “The authoritative Session is a consistent deny. Recovery means a current, safe and explainable decision—not forced success.” |
| 2:47–2:55 | Architecture trust boundary plus sanitized test result and closing line | “No valid observed world, no side effect. EpochGuard gates the action, not the explanation.” |

The video may shorten waiting but must not claim an unedited live duration. If
the measured Role Run intervals do not overlap, use the Dashboard's
`SEQUENTIAL_FALLBACK` label and remove any claim of parallel model execution.
Candidate/preflight badges, exact elapsed/start/end facts, architecture, and the
test card are labeled edit overlays sourced from the same candidate's sanitized
manifest; they are not product widgets. The product UI supplies `3/3` runtime
counts, overlap summary, IDs in evidence panels, and authoritative Snapshot
state. Never invent a timestamp or make an overlay resemble a live control.

Export at 1080p with readable text, normalized voice, no copyrighted music, and
duration below 180 seconds; target `2:50–2:55`. Watch the uploaded YouTube video
from beginning to end after processing, confirm it is public (not merely
unlisted if the form says public), enable/correct English captions, and reopen
the link in a logged-out window. The public repository, README, architecture
image, testing instructions, and video must all name the same candidate.

### 7.5 Truthful failure switch and Grand Final backup

The submission video itself is prerecorded, so it should never contain a fake
“live recovery.” For a rehearsal or Grand Final live presentation, use this
order:

1. **Primary:** current candidate running locally with the real ModelArk path.
2. **Backup:** a clearly labeled prerecorded full take from the exact public
   candidate, followed by the still-live local Dashboard/architecture for Q&A.
3. **Last resort:** the one-page architecture plus sanitized evidence manifest
   and screenshots. State that the external model path is unavailable; do not
   imply static evidence is executing.

Never use Mock Preview, controlled HTTP, a stale recording, or screenshots as
unlabeled proof of a live Run. If the API fails, preserve the error, explain the
external dependency in one sentence, and switch once—do not spend the pitch
debugging credentials.

Official pages confirm the September 11 Grand Final but do not publish its
pitch, live-demo, Q&A, slide, network, or connector limits. Prepare the same
three-minute core story, a local 1080p backup, offline architecture PNG/PDF, and
a 90-second optional technical appendix; only use the appendix after organizers
confirm the allotted time. Keep two local copies and one cloud copy, bring the
charger and video adapter, and do not claim the three-minute submission limit is
the final-stage pitch limit.

### 7.6 Final submission package

Before the September 1, 2026 **12:00 SGT** deadline, the package must contain:

- public repository at the reviewed candidate, with comprehensive English
  README, setup, problem/rationale, design, automated tests, demo steps,
  limitations, license, and third-party APIs/libraries/assets;
- the one-page architecture diagram showing middleware/data flow, trust
  boundary, enforcement, instrumentation, and recovery;
- public YouTube video under three minutes showing the complete real journey;
- English Devpost copy and accurate testing instructions; and
- free, restriction-free access to the public source, deterministic offline
  check, public video, and submission assets through at least September 7, 2026
  15:00 SGT. Because public schedule pages conflict, the Official Rules are the
  conservative source; keeping links available through winner announcement is
  safer.

Create and save the Devpost project draft early, then verify the exact form
fields instead of inferring character or image limits. Judges may evaluate only
the written description, images, and video, so each must tell the complete
problem → mechanism → evidence → outcome story without relying on a live test.
A public cloud deployment is not an official Track 1 requirement, and this
runbook does not claim that a live ModelArk service is currently hosted. A
reviewer can clone the public repository and run `npm ci && npm run check`
without any secret or paid account. A live ModelArk reproduction requires the
reviewer's own eligible BytePlus account/key and an activated model in the same
region, or a short-lived app-level access mechanism explicitly arranged by the
organizer/team for judging. Never send a judge `ARK_API_KEY`; any hosted entry
would expose only an app credential with scoped, revocable access. Describe any
free-token offer as eligibility-dependent, not guaranteed.

## 8. Container Runtime alternative

This remains a reviewer/development alternative, not the approved formal-demo
fallback. The current release evidence covers WSL2 `local-process`; do not use
Docker/Podman for the final capture or a live rescue until the exact candidate
has passed the same preflight, health, seven-Run, browser, and privacy gates on
that Runtime.

`npm run poc` is Bash-only and is supported from WSL, Linux, or macOS. It is not
a native PowerShell command. Complete the live credential preflight first, then
create another new root:

```bash
export LOCAL_POC_DATA_ROOT="$(mktemp -d /tmp/epochguard-container.XXXXXX)"
export APP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
: "${ARK_API_KEY:?Run the hidden-input credential preflight first}"
: "${ARK_MODEL:?Run the credential preflight first}"
case "$ARK_API_KEY" in replace-*|*'<'*|*'>'*) echo "Real ARK_API_KEY required"; exit 2;; esac
case "$ARK_MODEL" in *replace-*|*'<'*|*'>'*) echo "Real ARK_MODEL required"; exit 2;; esac
export ARK_BASE_URL="https://ark.ap-southeast.bytepluses.com/api/v3"

npm run poc
```

Open <http://localhost:3000>. The script selects Docker, Colima, or Podman,
builds the Runtime image, checks bind-mount write access, and requests the
`workspace-write` Codex sandbox. If Landlock is unavailable, it warns and uses
`danger-full-access` inside the ordinary outer container; that fallback is not
tenant isolation.

For Docker Compose, generate and set a real 24+ character URL-safe
`APP_AUTH_TOKEN` in `.env` in addition to `ARK_API_KEY` and `ARK_MODEL`.
Compose starts production on `0.0.0.0`; a placeholder token causes startup to
fail. The existing `bootstrap-local.sh` reminder omits this token step, so do
not rely on that reminder alone.

## 9. Native PowerShell environment (secondary)

WSL2 is the release-preferred path. If a reviewer deliberately uses native
PowerShell/local-process instead, use a separate clean Windows clone and its
own Windows `node_modules`; never share it with WSL. The environment is still
explicit—the production server reads `process.env`, not `.env`.

```powershell
$ErrorActionPreference = 'Stop'

if (git status --porcelain) { throw 'Use a clean Windows clone' }
git fetch --quiet origin refs/heads/epochguard/staging:refs/remotes/origin/epochguard/staging
if ($LASTEXITCODE -ne 0) { throw 'Could not refresh origin/epochguard/staging' }
$branch = (git branch --show-current).Trim()
if ($branch -cne 'epochguard/staging') { throw 'Checkout is not epochguard/staging' }
$env:EPOCHGUARD_CANDIDATE_SHA = (git rev-parse HEAD).Trim()
$remoteCandidate = (git rev-parse origin/epochguard/staging).Trim()
if ($env:EPOCHGUARD_CANDIDATE_SHA -cne $remoteCandidate) { throw 'Checkout does not match origin/epochguard/staging' }

npm ci
npm run check
if ($LASTEXITCODE -ne 0) { throw 'Deterministic gate failed' }

npm install --global @openai/codex@0.111.0
$codexPackage = Join-Path ((npm root --global).Trim()) '@openai/codex'
$codexExe = Get-ChildItem -LiteralPath $codexPackage -Recurse -File -Filter codex.exe |
  Where-Object { $_.FullName -match 'codex-win32' } |
  Select-Object -First 1
if ($null -eq $codexExe) { throw 'Could not resolve the native Codex executable' }
$env:CODEX_BIN = $codexExe.FullName
& $env:CODEX_BIN --version
if ($LASTEXITCODE -ne 0) { throw 'Native Codex executable check failed' }

$secureArkKey = Read-Host 'ARK_API_KEY' -AsSecureString
$env:ARK_API_KEY = [Net.NetworkCredential]::new('', $secureArkKey).Password
$env:ARK_MODEL = Read-Host 'ARK_MODEL (Responses-capable endpoint/model ID)'
$env:ARK_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3'
if ([string]::IsNullOrWhiteSpace($env:ARK_API_KEY) -or $env:ARK_API_KEY.StartsWith('replace-') -or $env:ARK_API_KEY.Contains('<') -or $env:ARK_API_KEY.Contains('>')) { throw 'Real ARK_API_KEY required' }
if ([string]::IsNullOrWhiteSpace($env:ARK_MODEL) -or $env:ARK_MODEL.Contains('replace-') -or $env:ARK_MODEL.Contains('<') -or $env:ARK_MODEL.Contains('>')) { throw 'Real ARK_MODEL required' }

$preflightRoot = Join-Path ([IO.Path]::GetTempPath()) ('epochguard-preflight-' + [guid]::NewGuid().ToString('N'))
$env:CODEX_HOME = Join-Path $preflightRoot 'codex-home'
$preflightWork = Join-Path $preflightRoot 'work'
$preflightJsonl = Join-Path $preflightRoot 'codex.jsonl'
$preflightFinal = Join-Path $preflightRoot 'final.txt'
$preflightStderr = Join-Path $preflightRoot 'codex.stderr.txt'
New-Item -ItemType Directory -Force -Path $env:CODEX_HOME, $preflightWork | Out-Null
node --input-type=module -e 'import { loadConfig, writeCodexConfig } from "./apps/server/dist/config.js"; await writeCodexConfig(loadConfig());'
if ($LASTEXITCODE -ne 0) { throw 'Could not generate the scratch Codex configuration' }
$env:EPOCHGUARD_PREFLIGHT_CODEX = $env:CODEX_BIN
$env:EPOCHGUARD_PREFLIGHT_WORK = $preflightWork
$env:EPOCHGUARD_PREFLIGHT_JSONL = $preflightJsonl
$env:EPOCHGUARD_PREFLIGHT_FINAL = $preflightFinal
$env:EPOCHGUARD_PREFLIGHT_STDERR = $preflightStderr
node --input-type=module -e @'
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const result = spawnSync(
  process.env.EPOCHGUARD_PREFLIGHT_CODEX,
  ["exec", "--ephemeral", "--json", "--output-last-message", process.env.EPOCHGUARD_PREFLIGHT_FINAL, "--sandbox", "read-only", "--skip-git-repo-check", "-C", process.env.EPOCHGUARD_PREFLIGHT_WORK, "Reply exactly EPOCHGUARD_PREFLIGHT_OK."],
  { encoding: "utf8", timeout: 180_000, windowsHide: true }
);
writeFileSync(process.env.EPOCHGUARD_PREFLIGHT_JSONL, result.stdout ?? "", { mode: 0o600 });
writeFileSync(process.env.EPOCHGUARD_PREFLIGHT_STDERR, result.stderr ?? "", { mode: 0o600 });
if (result.error) {
  console.error(result.error.code === "ETIMEDOUT" ? "Codex preflight timed out" : "Could not execute Codex preflight");
  process.exit(124);
}
process.exit(result.status ?? 1);
'@
$codexExit = $LASTEXITCODE
if ($codexExit -ne 0) { throw "Live Ark/Codex preflight exited $codexExit" }
if (-not (Test-Path -LiteralPath $preflightFinal)) { throw 'Codex did not write the final assistant message' }
$finalMessage = (Get-Content -LiteralPath $preflightFinal -Raw).Trim()
if ($finalMessage -cne 'EPOCHGUARD_PREFLIGHT_OK') { throw 'Final agent message did not exactly match the preflight marker' }
$env:EPOCHGUARD_LIVE_PREFLIGHT_SHA = (git rev-parse HEAD).Trim()

$demoRoot = Join-Path ([IO.Path]::GetTempPath()) ('epochguard-demo-' + [guid]::NewGuid().ToString('N'))
$env:APP_DATA_DIR = Join-Path $demoRoot 'data'
$env:AGENT_WORKSPACE_ROOT = Join-Path $demoRoot 'workspaces'
$env:CODEX_HOME = Join-Path $demoRoot 'codex-home'
New-Item -ItemType Directory -Force -Path $env:APP_DATA_DIR, $env:AGENT_WORKSPACE_ROOT, $env:CODEX_HOME | Out-Null

$env:APP_AUTH_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))"
$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '3101'
$env:RUNTIME_PROVIDER = 'local-process'
$env:CODEX_SANDBOX_MODE = 'workspace-write'

# Copy the browser token without printing it into the terminal or recording.
Set-Clipboard -Value $env:APP_AUTH_TOKEN

npm start
```

Open <http://127.0.0.1:3101>, paste the app token, select **Open Launchpad**,
then run `Set-Clipboard -Value ''` before recording. The native path still uses
one verified clean clone and a new product root plus a distinct port/origin for
every take; do not reuse browser or product state.

This PowerShell path does not turn the recorded WSL2 evidence into Windows
evidence or vice versa; report the environment actually used.

## 10. Failure handling

| Symptom | Meaning | Safe response |
| --- | --- | --- |
| `arkConfigured: false` or Runtime banner present | missing/placeholder Ark fields or unavailable Codex | Do not click Run; correct the explicit environment and repeat scratch preflight |
| Scratch preflight fails | real credential/model/runtime gate failed | Fix it outside product state; do not proceed |
| Create returns `201`, then Session becomes `FAILED` | background Run, output, binding, or profile failure | Preserve diagnostic evidence, abandon this take, fix the cause, and create a new data root |
| Diagnostic is `VALIDATE / DECISION_INVALID` | a structurally bound model Verdict conflicts with the fixed authoritative Role rule | Permit and Effect remain zero; preserve the diagnostic, abandon the take, and investigate Prompt/model behavior before retrying with a new root |
| `UNSTABLE_WORLD` | this scenario partition was already used or its head changed | Stop and start a new take with a new root; `Clear saved session` is not a reset |
| `AGENTS_BUSY` | the shared Role triple already has a non-terminal Session | Let the UI recover and observe that Session; do not send a second create |
| `ROLE_PROFILE_MISMATCH` | fixed Role identity, profile, status, or `AGENTS.md` digest changed | Do not edit the protected Agents; use a clean root/clone after diagnosing |
| `VIEW STALE — ACTIONS DISABLED` | three read failures or more than three seconds without a confirmed Snapshot | Keep actions disabled and retry GET; never infer success from a mutation response |
| `COMMIT_RACE` | World head advanced after validation | Effect remains zero; begin a new take rather than replaying Commit |
| Native PowerShell cannot run `npm run poc` | the script requires Bash | Use WSL/Linux/macOS or the native local-process route |

Stop the production server with `Ctrl+C`. Keep a scoped, revocable Ark key and
avoid production data. At the competition's completion, revoke the demo key and
app tokens and delete every scratch preflight root, rehearsal/demo data root,
Agent workspace, disposable `CODEX_HOME`, raw model output, raw logs, and unsafe
recording. Retain only the public source/submission assets and permitted,
sanitized hashes/evidence required for judging. Do not commit `.env`, temporary
state, visible tokens, or live model output.
