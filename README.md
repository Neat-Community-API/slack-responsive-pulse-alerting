# Silence the Noise: Responsive Slack Alerts for Neat Devices

Getting basic alerts when a Neat device goes offline or comes back online into Slack is pretty straightforward (there's a great [KB article on how to do that](https://support.neat.no/article/set-up-webhooks-for-slack/)). But while this is a great start, there's one main problem: **it can be noisy.**

There's a separate alert for a device going offline versus coming back online, which makes it difficult to truly understand which offline alerts still need actioning. You end up scrolling through a sea of notifications trying to match up "offline" and "online" messages.

This project adds a small piece of middleware that tracks incoming alerts and **updates** the original Slack message when an offline device comes back online. Messages show a red card for devices that are still offline and a green card for devices that have recovered. Now, someone supporting these devices can just scan the Slack channel for the obvious red messages and get to work.

> Read the full write-up: [Silence the Noise: Responsive Slack Alerts for Neat Devices](https://www.chrisrouge.com/blog/responsive-slack-alerts-neat-pulse)

## How It Works

Think of it like a smart receptionist for your alerts. Instead of just forwarding every single message, the receptionist keeps a log. When a device goes offline, they post a red sticky note on the board. When it comes back online, instead of adding a new note, they swap the red sticky note for a green one.

The "receptionist" is a [Supabase Edge Function](https://supabase.com/docs/guides/functions). It uses a database table to store alert state and Slack message coordinates, and the edge function processes incoming Neat Pulse webhooks and updates Slack accordingly.

## Project Structure

```
supabase/
├── config.toml                                          # Supabase project config
├── functions/
│   └── neat-pulse-alerts/
│       └── index.ts                                     # Edge function: webhook receiver + Slack updater
└── migrations/
    └── 20260319224500_create_neat_pulse_alert_state.sql  # Database migration for alert state table
```

## Setup

You don't need to be a wizard to get started, but you will need a few prerequisites:

- A [Supabase](https://supabase.com) account (free tier works)
- A Slack workspace you can add apps to
- The [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) installed locally
- Access to [Neat Pulse](https://pulse.neat.no) alerting settings

### 1. Fork and Clone the Repo

Fork this repo and clone it locally.

### 2. Create a Supabase Project

Go to [supabase.com/dashboard](https://supabase.com/dashboard) and create a new project. Note your **Project URL** and **Service Role Key** from **Settings > API**.

### 3. Create the Database Table

In the Supabase SQL Editor, open and run the migration file at `supabase/migrations/`. This creates the `neat_pulse_alert_state` table that tracks each device's current status and the Slack message coordinates needed to update alerts later.

### 4. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App > From scratch**.
2. Under **OAuth & Permissions**, add the bot scope: `chat:write`.
3. Click **Install to Workspace** and authorize.
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`).
5. In Slack, right-click the channel you want alerts in > **View channel details** > copy the **Channel ID** (starts with `C`).

> **Why a bot token and not an incoming webhook?** The function needs to *update* the original offline message when the device recovers. Incoming webhooks can only post new messages. The `chat.update` API method requires a bot token.

### 5. Set Your Secrets

**Option A: Supabase Dashboard (UI)**

1. Go to your project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Navigate to **Edge Functions** in the left sidebar.
3. Click **Manage Secrets**.
4. Add each of the following as a new secret:

| Secret | Value |
|--------|-------|
| `SUPABASE_URL` | `https://your-project-id.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service role key |
| `SLACK_BOT_TOKEN` | `xoxb-your-bot-token` |
| `SLACK_CHANNEL_ID` | `C0123456789` |

**Option B: Supabase CLI**

> Don't have the CLI? Install it with `brew install supabase/tap/supabase` (macOS) or check the [install docs](https://supabase.com/docs/guides/local-development/cli/getting-started) for other platforms.

```bash
supabase link --project-ref your-project-id

supabase secrets set \
  SUPABASE_URL=https://your-project-id.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
  SLACK_BOT_TOKEN=xoxb-your-bot-token \
  SLACK_CHANNEL_ID=C0123456789
```

**Optional secrets:**

| Secret | Description |
|--------|-------------|
| `PULSE_ORG_ID` | Your Neat Pulse org ID. When set, Slack messages include an **Open in Pulse** button linking directly to the affected device. |
| `NEAT_WEBHOOK_SECRET` | Shared secret for webhook signature verification. If configured in Neat Pulse, set the same value here. |

### 6. Deploy the Edge Function

From the root of your cloned repo:

```bash
supabase link --project-ref your-project-id
supabase functions deploy neat-pulse-alerts --no-verify-jwt
```

The `--no-verify-jwt` flag makes the endpoint publicly accessible, which is required because Neat's webhook won't send a Supabase JWT.

Your function URL will be:

```
https://your-project-id.supabase.co/functions/v1/neat-pulse-alerts
```

### 7. Configure Neat Pulse

1. In Neat Pulse, go to **Settings > Alerts & Events**.
2. Click **Create Rule**.
3. Name the rule and select **Device Connection Status** under Events.
4. Paste the function URL from step 6 into the **Webhook URL** field and select **Cloudevents (Structured)** for the format.
5. Test the webhook, create it, and enable it with the toggle button.

### 8. Test It Out

First, confirm the function is reachable:

```bash
curl https://your-project-id.supabase.co/functions/v1/neat-pulse-alerts
```

You should get back:

```json
{"ok":true,"message":"neat-pulse-alerts endpoint is reachable"}
```

Then trigger a real alert from a Neat device (unplugging it or giving it a reboot should do the trick) and watch for the red Slack message. Once it boots back up, watch that red message turn green!

## Alert Behavior

| Scenario | What happens |
|----------|-------------|
| First offline event for a device | Posts a red Slack message and stores the message coordinates |
| Another offline event while still open | Updates the existing red message (no duplicate) |
| Online event while an incident is open | Updates the same Slack message to green (resolved) |
| Online event with no open incident | Records state only, no Slack message |

## License

MIT
