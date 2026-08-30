# EpochGuard Reproducible Demo Runbook

This runbook reproduces the two fixed EpochGuard worlds without treating a
deterministic test double as a real model. It is written for a judge, reviewer,
or recording operator starting from a clean machine state.

> [!IMPORTANT]
> **Current release status — 2026-08-30:** `npm run check` passes in WSL2
> (361/361 server tests, 6/6 web tests, TypeScript, and production builds). The final
> candidate's real Volcengine Ark/Codex lifecycle and seven-Run recording have
> **not yet been completed**. Follow this document to run that open gate; do not
> report it as passed in advance.

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

Expected current deterministic result:

```text
Server Test Files  23 passed (23)
Server Tests       361 passed (361)
Web Test Files      1 passed (1)
Web Tests            6 passed (6)
Web typecheck/build: pass
Server typecheck/build: pass
```

These tests use deterministic fixtures and controlled runners. They do not
validate Ark credentials or remote model behavior. They deliberately run before
any secret enters the shell.

Install and resolve the pinned Linux Codex CLI only after the offline gate:

```bash
npm install --global @openai/codex@0.111.0
export CODEX_BIN="$(npm prefix --global)/bin/codex"
case "$CODEX_BIN" in /*) ;; *) echo "CODEX_BIN must be an absolute Linux path"; exit 2;; esac
test -x "$CODEX_BIN"
"$CODEX_BIN" --version
```

The explicit branch is required until the real Ark gate passes and the reviewed
candidate is promoted: the repository's default `main` intentionally remains
the Starter baseline during release verification.

Use `"$CODEX_BIN"` for every later invocation. Do not switch to
`command -v codex` or bare `codex`: an inherited Windows PATH can shadow the
Linux global install with an incompatible Windows shim. The expected version
line is `codex-cli 0.111.0`.

Only now set Ark configuration explicitly in this shell. `npm run dev` does not
load `.env`. If a key is not available, stop here: the deterministic candidate
remains testable, while the real preflight and seven product Runs remain open.

```bash
read -rsp "ARK_API_KEY: " ARK_API_KEY; echo
export ARK_API_KEY

read -rp "ARK_MODEL (Responses-capable endpoint/model ID): " ARK_MODEL
export ARK_MODEL

export ARK_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"

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

## 4. Start one fresh WSL2/local-process take

After the live preflight passes, replace the scratch `CODEX_HOME` with a newly
created product root. Keep this root for both scenarios in this one take.

```bash
export EPOCHGUARD_DEMO_ROOT="$(mktemp -d /tmp/epochguard-demo.XXXXXX)"
export APP_DATA_DIR="$EPOCHGUARD_DEMO_ROOT/data"
export AGENT_WORKSPACE_ROOT="$EPOCHGUARD_DEMO_ROOT/workspaces"
export CODEX_HOME="$EPOCHGUARD_DEMO_ROOT/codex-home"
mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"

export APP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
export NODE_ENV=development
export HOST=127.0.0.1
export PORT=3000
export RUNTIME_PROVIDER=local-process
export CODEX_SANDBOX_MODE=workspace-write

test "${#APP_AUTH_TOKEN}" -ge 24
case "$APP_AUTH_TOKEN" in *[!A-Za-z0-9._~-]*) echo "Token is not URL-safe"; exit 2;; esac

# WSL can copy the token to the Windows clipboard without printing it.
printf %s "$APP_AUTH_TOKEN" | clip.exe

npm run dev
```

The shell exports are the configuration. Creating `.env` is not sufficient for
`npm run dev`, because the server is plain `tsx watch` and reads
`process.env` only.

Wait for both development processes:

```text
Web UI: http://localhost:5173
API:    http://localhost:3000
```

Open the Web UI, paste `APP_AUTH_TOKEN` into **Enter the access token**, and
select **Open Launchpad**. Before clicking a scenario:

- confirm the **Runtime configuration needed** banner is absent;
- confirm the Runtime card reports the intended Ark model and an available
  Codex Runtime; and
- retain the successful scratch preflight as the actual credential evidence.

The app initializes exactly three fixed Role Agents. The UI automatically
resolves them by exact name and hides them from the Agent Chat sidebar. Do not
create or manually select Role Agents.

## 5. Run the seven-model-call story

### Normal World — Runs 1 to 3

1. Select **Session Safety** in the top workspace switcher.
2. Confirm the launcher lists the fixed Inventory, Budget, and Policy Role
   Agents. This is a read-only automatic resolution, not a picker.
3. Select **Normal World**.
4. Click **`Run Normal World`** exactly once.
5. Observe the initial `201`/`DISPATCHING` Snapshot, then queued/running Role
   Attempts. Wait for all three real Agent cards to show their own Run evidence.
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
| Deterministic | `npm run check` | Server 23 files / 361 tests and Web 1 file / 6 tests; both typechecks and builds pass |
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

## 7. Recording a truthful three-minute video

Seven real product Runs plus the required preflight are not guaranteed to
finish live within three minutes. Record the actual candidate first, then make
an edited/accelerated `2:50–2:55` video. Label speed-ups or jump cuts, preserve
real IDs and elapsed times around each cut, and never replace a wait with Mock
Preview footage.

| Target time | Evidence on screen | Narration |
| ---: | --- | --- |
| 0:00–0:12 | Project tagline, candidate revision, successful scratch preflight; secrets hidden | Every Agent can be locally right while the team's combined world never existed |
| 0:12–0:22 | New data root identifier reduced to a neutral label; Session Safety launcher auto-resolves three Roles | Fresh one-shot Stores; no manual Role selection |
| 0:22–0:45 | `Run Normal World`; accelerated wait; three real Run IDs | Three isolated specialists use server-issued evidence |
| 0:45–0:57 | `READY`, then `Commit protected effect`, Effect count 1 | Current joint validity admits exactly one local Effect |
| 0:57–1:08 | `Clear saved session`; switch and click `Run Impossible World` | Separate pristine Impossible partition in the same take |
| 1:08–1:34 | Accelerated wait; three real Runs and three `ALLOW` cards | Each local decision is correct for its observation |
| 1:34–1:58 | No-cut panel, intervals, `L=21`, `U=20`, witness, effect 0 | The authoritative intervals have no common revision, so the backend blocks |
| 1:58–2:12 | Raw proof and Gate | Browser displays one Snapshot; it does not calculate or release |
| 2:12–2:34 | `Re-observe Budget only`; accelerated seventh Run | The server preserves two valid owners and avoids two reruns |
| 2:34–2:49 | Budget `DENY`, counts `1/2/1`, `CONSISTENT_DENY`, effect 0 | Recovery is a current safe decision, not forced success |
| 2:49–2:55 | Test result and closing line | No valid observed world. No side effect. |

The video may shorten waiting but must not claim an unedited live duration. If
the measured Role Run intervals do not overlap, use the Dashboard's
`SEQUENTIAL_FALLBACK` label and remove any claim of parallel model execution.

## 8. Container Runtime alternative

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
export ARK_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"

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
explicit—`.env` is not loaded by `npm run dev`.

```powershell
$ErrorActionPreference = 'Stop'

if (git status --porcelain) { throw 'Use a clean Windows clone' }
$env:EPOCHGUARD_CANDIDATE_SHA = (git rev-parse HEAD).Trim()
$remoteCandidate = (git rev-parse origin/epochguard/staging).Trim()
if ($env:EPOCHGUARD_CANDIDATE_SHA -cne $remoteCandidate) { throw 'Checkout does not match origin/epochguard/staging' }

npm ci
npm run check
if ($LASTEXITCODE -ne 0) { throw 'Deterministic gate failed' }

npm install --global @openai/codex@0.111.0
$env:CODEX_BIN = (Get-Command codex).Source

$secureArkKey = Read-Host 'ARK_API_KEY' -AsSecureString
$env:ARK_API_KEY = [Net.NetworkCredential]::new('', $secureArkKey).Password
$env:ARK_MODEL = Read-Host 'ARK_MODEL (Responses-capable endpoint/model ID)'
$env:ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
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
$env:NODE_ENV = 'development'
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$env:RUNTIME_PROVIDER = 'local-process'
$env:CODEX_SANDBOX_MODE = 'workspace-write'

# Copy the browser token without printing it into the terminal or recording.
Set-Clipboard -Value $env:APP_AUTH_TOKEN

npm run dev
```

This PowerShell path does not turn the recorded WSL2 evidence into Windows
evidence or vice versa; report the environment actually used.

## 10. Failure handling

| Symptom | Meaning | Safe response |
| --- | --- | --- |
| `arkConfigured: false` or Runtime banner present | missing/placeholder Ark fields or unavailable Codex | Do not click Run; correct the explicit environment and repeat scratch preflight |
| Scratch preflight fails | real credential/model/runtime gate failed | Fix it outside product state; do not proceed |
| Create returns `201`, then Session becomes `FAILED` | background Run, output, binding, or profile failure | Preserve diagnostic evidence, abandon this take, fix the cause, and create a new data root |
| `UNSTABLE_WORLD` | this scenario partition was already used or its head changed | Stop and start a new take with a new root; `Clear saved session` is not a reset |
| `AGENTS_BUSY` | the shared Role triple already has a non-terminal Session | Let the UI recover and observe that Session; do not send a second create |
| `ROLE_PROFILE_MISMATCH` | fixed Role identity, profile, status, or `AGENTS.md` digest changed | Do not edit the protected Agents; use a clean root/clone after diagnosing |
| `VIEW STALE — ACTIONS DISABLED` | three read failures or more than three seconds without a confirmed Snapshot | Keep actions disabled and retry GET; never infer success from a mutation response |
| `COMMIT_RACE` | World head advanced after validation | Effect remains zero; begin a new take rather than replaying Commit |
| Native PowerShell cannot run `npm run poc` | the script requires Bash | Use WSL/Linux/macOS or the native local-process route |

Stop the development processes with `Ctrl+C`. Keep a scoped, revocable Ark key,
avoid production data, and revoke demo credentials after the event. Do not
commit the temporary data root, workspaces, Codex home, `.env`, recordings with
visible tokens, or live model output.
