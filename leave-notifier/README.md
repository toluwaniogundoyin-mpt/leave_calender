# leave-notifier

Posts upcoming-leave reminders to a Slack channel, and lets the team add/check
leave days with a `/leave` slash command — without leaving Slack.

Two moving pieces:

- **`notify/`** — a GitHub Actions workflow that reads `data/leaves.yaml` and
  posts due reminders to Slack via an Incoming Webhook. Modeled on the
  `coralpay-balance-alert` project's pattern (Slack webhook + git-committed
  JSON latch to avoid duplicate posts).
- **`slack-bot/`** — a small Cloudflare Worker that handles the `/leave`
  slash command (`add`, `check`). It reads/writes `data/leaves.yaml` directly
  via the GitHub Contents API. This piece exists only because Slack requires
  a live HTTP endpoint that responds in under 3 seconds — something GitHub
  Actions can't provide on its own.

## 1. Create the GitHub repo

```bash
cd leave-notifier
git init
git add .
git commit -m "Initial leave notifier scaffold"
gh repo create <your-org>/leave-notifier --private --source=. --push
```

## 2. Create the Slack app

At https://api.slack.com/apps → **Create New App** → From scratch, in your workspace.

1. **Incoming Webhooks**: turn on, click "Add New Webhook to Workspace", pick
   the target channel. Copy the webhook URL — this is `SLACK_WEBHOOK_URL`.
2. **Slash Commands**: create `/leave`.
   - Request URL: fill in *after* deploying the Worker in step 4 (you can
     save a placeholder now and come back).
   - Short description: `Manage team leave`
   - Usage hint: `add @user YYYY-MM-DD YYYY-MM-DD [note] | check`
3. **Basic Information** → App Credentials: copy the **Signing Secret** —
   this is `SLACK_SIGNING_SECRET`.
4. **Install App** to your workspace.

## 3. GitHub token for the Worker

Create a **fine-grained personal access token** (github.com → Settings →
Developer settings → Fine-grained tokens):

- Repository access: only `leave-notifier`
- Permissions: **Contents: Read and write**

Copy it — this is `GITHUB_TOKEN`, used only by the Worker (the Actions
workflow uses its own built-in token, no extra setup needed there).

## 4. Deploy the Cloudflare Worker

```bash
cd slack-bot
npm install
npx wrangler login

# Edit wrangler.toml: set GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH.

npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put GITHUB_TOKEN

npx wrangler deploy
```

Take the deployed `*.workers.dev` URL and paste it (with no extra path
needed — the Worker handles any POST) into the Slack app's Slash Command
Request URL. Save.

Test locally before deploying with `npx wrangler dev` if you want to try
requests against a local instance first (you'll need to hand-craft a signed
request, or just deploy and test against the real Slack command — simplest
for a first pass).

## 5. GitHub Actions secret for the reminder job

In the repo settings → Secrets and variables → Actions:

- `SLACK_WEBHOOK_URL` — from step 2.

## 6. Schedule the reminder workflow

The workflow (`.github/workflows/remind.yml`) is `workflow_dispatch`-only, so
it needs something to trigger it daily. Matching the existing
`coralpay-balance-alert` convention, use https://cron-job.org (free):

- URL: `https://api.github.com/repos/<owner>/leave-notifier/actions/workflows/remind.yml/dispatches`
- Method: `POST`
- Headers: `Authorization: Bearer <a PAT with Actions: Read and write>`, `Accept: application/vnd.github+json`
- Body: `{"ref":"main"}`
- Schedule: once daily (morning, in your team's timezone)

Alternatively, add a native `schedule:` trigger directly in `remind.yml` —
simpler to set up, but GitHub may delay scheduled runs by minutes-to-hours on
low-activity repos, which is why the existing project avoids it.

## Usage

```
/leave add @jane 2026-08-20 2026-08-25 Annual leave
/leave check
```

Reminders are sent automatically:

- 3 days before a leave starts
- the day a leave starts
- the day a leave ends ("back tomorrow")

## Local development

```bash
# Worker
cd slack-bot && npm install && npx wrangler dev

# Reminder script
cd notify
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SLACK_WEBHOOK_URL=https://hooks.slack.com/... python3 remind.py
```
