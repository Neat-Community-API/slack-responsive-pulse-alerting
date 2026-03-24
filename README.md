# Neat Pulse Slack Alerting

Minimal Supabase implementation for Neat Pulse webhook alerts:

- offline event: posts a red Slack message
- matching online event for the same device: updates the same Slack message to green
- state storage: one Postgres table in Supabase

## Layout

- `supabase/functions/neat-pulse-alerts/index.ts`: webhook receiver and Slack updater
- `supabase/migrations/20260319224500_create_neat_pulse_alert_state.sql`: device alert state table
- `supabase/config.toml`: marks the function as public so Neat can call it

## Slack setup

Create a Slack app with a bot token that has:

- `chat:write`

Install the app into the workspace and copy:

- bot token as `SLACK_BOT_TOKEN`
- destination channel ID as `SLACK_CHANNEL_ID`

This uses Slack Web API methods `chat.postMessage` and `chat.update`, not an incoming webhook. That is required because the message must be updated later when the device comes back online.

## Supabase setup

1. Create a Supabase project.
2. In SQL Editor, run the migration in [supabase/migrations/20260319224500_create_neat_pulse_alert_state.sql](/Users/lazlo/neatCode/slack-alerting/supabase/migrations/20260319224500_create_neat_pulse_alert_state.sql).
3. Create these function secrets:

```bash
supabase secrets set \
  SUPABASE_URL=https://your-project-id.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
  SLACK_BOT_TOKEN=xoxb-your-bot-token \
  SLACK_CHANNEL_ID=C0123456789 \
  PULSE_ORG_ID=KM9l3GX \
  NEAT_WEBHOOK_SECRET=optional-shared-secret
```

4. Deploy the function:

```bash
supabase functions deploy neat-pulse-alerts --no-verify-jwt
```

Your endpoint will look like:

```text
https://YOUR-PROJECT-ID.supabase.co/functions/v1/neat-pulse-alerts
```

## Neat Pulse setup

In Neat Pulse alerting:

- add a webhook destination pointing to the deployed Supabase function URL
- use `POST`
- if you configure a webhook secret in Neat, set the same value as `NEAT_WEBHOOK_SECRET`

The function expects JSON and tries to handle common CloudEvents-style payloads. Matching is done by device identity, not by alert ID, since Neat sends distinct IDs for offline and online events.

If you set `PULSE_ORG_ID`, the Slack message includes an `Open in Pulse` button that links directly to the affected device:

```text
https://pulse.neat.no/PULSE_ORG_ID/p/rooms/device/DEVICE_ID
```

## Behavior

- first offline event for a device:
  posts a red Slack message and stores `channel` + `ts`
- another offline event while still open:
  updates the existing red message instead of posting a duplicate
- online event for the same device while open:
  updates that same Slack message to green and marks the incident resolved
- online event with no open incident:
  updates database state only and does not post to Slack

## Table shape

One row per device in `public.neat_pulse_alert_state`.

Important fields:

- `device_key`: stable key used to match alerts for the same device
- `active_incident`: whether there is currently an open offline incident
- `slack_channel` and `slack_ts`: required to update the existing Slack message
- `raw_payload`: full last webhook payload for debugging

## Notes

- The parser is intentionally defensive because Neat’s webhook payload fields can vary by event type.
- If you already know the exact Neat payload for offline and online events, the parser can be tightened further.
- No retries or queuing are implemented here. This is the simplest working path.
