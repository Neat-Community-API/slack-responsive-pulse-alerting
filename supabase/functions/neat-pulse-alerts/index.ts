import { createClient } from "jsr:@supabase/supabase-js@2";

type JsonObject = Record<string, unknown>;

type ParsedEvent = {
  eventId: string | null;
  eventType: string;
  eventAt: string;
  status: "offline" | "online";
  deviceKey: string;
  deviceSerial: string | null;
  deviceId: string | null;
  deviceName: string;
  deviceModel: string | null;
  roomName: string | null;
  locationName: string | null;
  summary: string;
  payload: JsonObject;
};

const SLACK_BOT_TOKEN = mustGetEnv("SLACK_BOT_TOKEN");
const SLACK_CHANNEL_ID = mustGetEnv("SLACK_CHANNEL_ID");
const SUPABASE_URL = mustGetEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");
const NEAT_WEBHOOK_SECRET = Deno.env.get("NEAT_WEBHOOK_SECRET")?.trim() || "";
const PULSE_ORG_ID = Deno.env.get("PULSE_ORG_ID")?.trim() || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (request) => {
  if (request.method === "GET") {
    return jsonResponse({ ok: true, message: "neat-pulse-alerts endpoint is reachable" });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const rawBody = await request.text();
  const signatureError = await verifySignature(request, rawBody);
  if (signatureError) {
    return jsonResponse({ error: signatureError }, 401);
  }

  if (!rawBody.trim()) {
    console.log("accepted empty test request");
    return jsonResponse({ ok: true, action: "accepted_empty_test_request" });
  }

  let payload: JsonObject;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonResponse({ error: "invalid_json_object" }, 400);
    }

    payload = parsed as JsonObject;
  } catch {
    console.log("accepted non-json test request");
    return jsonResponse({ ok: true, action: "accepted_non_json_test_request" });
  }

  if (isTestPayload(payload)) {
    console.log("accepted test payload");
    return jsonResponse({ ok: true, action: "accepted_test_event" });
  }

  let event: ParsedEvent;
  try {
    event = parseIncomingEvent(payload, request.headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_payload";
    console.log("ignored unsupported event", { reason: message, payload });
    return jsonResponse({ ok: true, action: "ignored_unsupported_event", reason: message });
  }

  console.log("parsed event", {
    eventType: event.eventType,
    status: event.status,
    deviceKey: event.deviceKey,
    deviceName: event.deviceName,
  });

  const existingState = await getDeviceState(event.deviceKey);
  console.log("loaded existing state", { deviceKey: event.deviceKey, existingState });

  if (event.status === "offline") {
    await upsertState(event, {
      activeIncident: true,
      slackChannel: existingState?.slack_channel ?? null,
      slackTs: existingState?.slack_ts ?? null,
    });
    console.log("persisted offline state before slack", { deviceKey: event.deviceKey });

    if (existingState?.active_incident && existingState.slack_channel && existingState.slack_ts) {
      await updateSlackMessage(existingState.slack_channel, existingState.slack_ts, buildSlackMessage(event, "offline"));
      console.log("updated existing slack offline message", {
        channel: existingState.slack_channel,
        ts: existingState.slack_ts,
      });

      await upsertState(event, {
        activeIncident: true,
        slackChannel: existingState.slack_channel,
        slackTs: existingState.slack_ts,
      });

      return jsonResponse({ ok: true, action: "updated_existing_offline_message" });
    }

    const slackMessage = await postSlackMessage(SLACK_CHANNEL_ID, buildSlackMessage(event, "offline"));
    console.log("posted new slack offline message", slackMessage);

    await upsertState(event, {
      activeIncident: true,
      slackChannel: slackMessage.channel,
      slackTs: slackMessage.ts,
    });

    return jsonResponse({ ok: true, action: "posted_offline_message" });
  }

  await upsertState(event, {
    activeIncident: false,
    slackChannel: existingState?.slack_channel ?? null,
    slackTs: existingState?.slack_ts ?? null,
  });
  console.log("persisted online state before slack", { deviceKey: event.deviceKey });

  if (existingState?.active_incident && existingState.slack_channel && existingState.slack_ts) {
    await updateSlackMessage(existingState.slack_channel, existingState.slack_ts, buildSlackMessage(event, "online"));
    console.log("updated slack online resolution message", {
      channel: existingState.slack_channel,
      ts: existingState.slack_ts,
    });

    await upsertState(event, {
      activeIncident: false,
      slackChannel: existingState.slack_channel,
      slackTs: existingState.slack_ts,
    });

    return jsonResponse({ ok: true, action: "resolved_existing_message" });
  }

  return jsonResponse({ ok: true, action: "recorded_online_without_open_incident" });
});

function mustGetEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function verifySignature(request: Request, rawBody: string): Promise<string | null> {
  if (!NEAT_WEBHOOK_SECRET) {
    return null;
  }

  const headerValue = request.headers.get("webhook-signature");
  if (!headerValue) {
    return "missing_webhook_signature";
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(NEAT_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = toHex(signature);

  const normalizedHeader = headerValue.trim().toLowerCase().replace(/^sha256=/, "");
  if (!timingSafeEqual(normalizedHeader, expected)) {
    return "invalid_webhook_signature";
  }

  return null;
}

function parseIncomingEvent(payload: JsonObject, headers: Headers): ParsedEvent {
  const connectedStatus = objectOr(payload.device_connected_status);
  const eventType = stringOr(
    payload.type,
    payload.eventType,
    hasKeys(connectedStatus) ? "device_connected_status" : "",
    headers.get("ce-type"),
    headers.get("x-neat-event-type"),
    "unknown",
  ).toLowerCase();

  const eventId = stringOrNull(payload.id, payload.eventId, headers.get("ce-id"));
  const eventAt = stringOr(
    payload.time,
    payload.timestamp,
    payload.createdAt,
    headers.get("ce-time"),
    new Date().toISOString(),
  );

  const connectedObject = objectOr(connectedStatus.object);
  const connectedMetadata = objectOr(connectedObject.metadata);
  const data = objectOr(payload.data, payload.alert, payload.endpoint, connectedStatus, payload.device, payload);
  const device = objectOr(
    connectedObject.device,
    data.device,
    data.endpoint,
    data.resource,
    connectedObject,
    data,
  );
  const room = objectOr(connectedMetadata.room, data.room, device.room);
  const location = objectOr(connectedMetadata.location, data.location, room.location, device.location);

  const deviceId = stringOrNull(
    device.id,
    device.deviceId,
    device.endpointId,
    data.deviceId,
    data.endpointId,
  );

  const deviceSerial = stringOrNull(
    device.serial,
    device.serialNumber,
    data.serial,
    data.serialNumber,
  );

  const deviceName = stringOr(
    device.name,
    device.deviceName,
    data.deviceName,
    data.name,
    deviceSerial,
    deviceId,
    "Unknown device",
  );

  const deviceModel = stringOrNull(
    device.model,
    data.deviceModel,
    data.model,
    device.model_code,
  );

  const deviceKey = stringOr(
    device.deviceKey,
    device.serialNumber,
    device.serial,
    device.macAddress,
    device.id,
    device.deviceId,
    data.deviceId,
    data.endpointId,
    deviceName,
  );

  const roomName = stringOrNull(room.name, data.roomName);
  const locationName = stringOrNull(location.name, data.locationName);

  const status = deriveStatus(payload, data, eventType);
  if (!status) {
    throw new Error("unsupported_event_type");
  }

  const summary = stringOr(
    data.message,
    data.summary,
    payload.subject,
    payload.title,
    buildConnectionSummary(deviceName, connectedStatus, status),
    `${deviceName} is ${status}`,
  );

  return {
    eventId,
    eventType,
    eventAt,
    status,
    deviceKey,
    deviceSerial,
    deviceId,
    deviceName,
    deviceModel,
    roomName,
    locationName,
    summary,
    payload,
  };
}

function isTestPayload(payload: JsonObject): boolean {
  const candidates = [
    stringOrNull(payload.type, payload.eventType, payload.subject, payload.title),
    stringOrNull(payload.message),
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (candidates.length === 0 && Object.keys(payload).length === 0) {
    return true;
  }

  return candidates.some((candidate) =>
    candidate.includes("test") ||
    candidate.includes("ping") ||
    candidate.includes("verify") ||
    candidate.includes("validation"),
  );
}

function deriveStatus(payload: JsonObject, data: JsonObject, eventType: string): "offline" | "online" | null {
  const connectedStatus = objectOr(payload.device_connected_status, data.device_connected_status);
  const currentConnection = booleanOrNull(connectedStatus.current);
  if (currentConnection === false) {
    return "offline";
  }

  if (currentConnection === true) {
    return "online";
  }

  const candidates = [
    eventType,
    stringOrNull(data.status, data.state, data.alertType, payload.status, payload.state),
    stringOrNull(data.message, data.summary, payload.subject, payload.title),
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  for (const candidate of candidates) {
    if (candidate.includes("offline")) {
      return "offline";
    }

    if (
      candidate.includes("online") ||
      candidate.includes("resolved") ||
      candidate.includes("recovered") ||
      candidate.includes("back up")
    ) {
      return "online";
    }
  }

  return null;
}

async function getDeviceState(deviceKey: string) {
  const { data, error } = await supabase
    .from("neat_pulse_alert_state")
    .select("device_key, active_incident, slack_channel, slack_ts")
    .eq("device_key", deviceKey)
    .maybeSingle();

  if (error) {
    console.error("failed to load state", { deviceKey, error });
    throw new Error(`failed_to_load_state: ${error.message}`);
  }

  return data;
}

async function upsertState(
  event: ParsedEvent,
  slack: { activeIncident: boolean; slackChannel: string | null; slackTs: string | null },
) {
  const { error } = await supabase.from("neat_pulse_alert_state").upsert({
    device_key: event.deviceKey,
    device_id: event.deviceId,
    device_name: event.deviceName,
    room_name: event.roomName,
    location_name: event.locationName,
    status: event.status,
    active_incident: slack.activeIncident,
    slack_channel: slack.slackChannel,
    slack_ts: slack.slackTs,
    last_event_id: event.eventId,
    last_event_type: event.eventType,
    last_event_at: event.eventAt,
    raw_payload: event.payload,
  });

  if (error) {
    console.error("failed to upsert state", { deviceKey: event.deviceKey, error });
    throw new Error(`failed_to_upsert_state: ${error.message}`);
  }
}

function buildSlackMessage(event: ParsedEvent, status: "offline" | "online") {
  const accentColor = status === "offline" ? "#D92D20" : "#16A34A";
  const glyph = status === "offline" ? "🟥" : "🟩";
  const title = buildAlertTitle(event, status);
  const fields = [
    mrkdwnField("*Device*\n" + event.deviceName),
    mrkdwnField("*Status*\n" + status.toUpperCase()),
  ];

  if (event.deviceModel) {
    fields.push(mrkdwnField("*Model*\n" + event.deviceModel));
  }

  if (event.roomName) {
    fields.push(mrkdwnField("*Room*\n" + event.roomName));
  }

  if (event.locationName) {
    fields.push(mrkdwnField("*Location*\n" + event.locationName));
  }

  fields.push(mrkdwnField("*Event Time*\n" + event.eventAt));

  const attachment: {
    color: string;
    blocks: unknown[];
  } = {
    color: accentColor,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${glyph} ${title}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${event.deviceName}*\n${event.summary}` },
      },
      {
        type: "section",
        fields,
      },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `Device serial: \`${event.deviceSerial ?? event.deviceKey}\`` },
              { type: "mrkdwn", text: `Event type: \`${event.eventType}\`` },
            ],
          },
    ],
  };

  const pulseUrl = buildPulseDeviceUrl(event.deviceId);
  if (pulseUrl) {
    attachment.blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in Pulse" },
          url: pulseUrl,
        },
      ],
    });
  }

  return {
    text: status === "offline" ? offlineText(event) : onlineText(event),
    attachments: [attachment],
  };
}

function mrkdwnField(text: string) {
  return { type: "mrkdwn", text };
}

function offlineText(event: ParsedEvent): string {
  return `${event.deviceName} is offline`;
}

function onlineText(event: ParsedEvent): string {
  return `${event.deviceName} is back online`;
}

async function postSlackMessage(
  channel: string,
  message: { text: string; attachments: unknown[] },
) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text: message.text, attachments: message.attachments }),
  });

  const payload = await response.json() as { ok?: boolean; error?: string; channel?: string; ts?: string };
  if (!response.ok || !payload.ok || !payload.channel || !payload.ts) {
    console.error("slack post failed", { channel, status: response.status, payload });
    throw new Error(`slack_post_failed: ${payload.error ?? response.status}`);
  }

  return { channel: payload.channel, ts: payload.ts };
}

async function updateSlackMessage(
  channel: string,
  ts: string,
  message: { text: string; attachments: unknown[] },
) {
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, ts, text: message.text, attachments: message.attachments }),
  });

  const payload = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || !payload.ok) {
    console.error("slack update failed", { channel, ts, status: response.status, payload });
    throw new Error(`slack_update_failed: ${payload.error ?? response.status}`);
  }
}

function stringOr(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function stringOrNull(...values: unknown[]): string | null {
  const value = stringOr(...values);
  return value || null;
}

function objectOr(...values: unknown[]): JsonObject {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as JsonObject;
    }
  }

  return {};
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function hasKeys(value: JsonObject): boolean {
  return Object.keys(value).length > 0;
}

function buildConnectionSummary(deviceName: string, connectedStatus: JsonObject, status: "offline" | "online"): string {
  const previous = booleanOrNull(connectedStatus.previous);
  const current = booleanOrNull(connectedStatus.current);
  if (previous !== null && current !== null) {
    return `${deviceName} changed connection state from ${previous ? "online" : "offline"} to ${current ? "online" : "offline"}`;
  }

  return `${deviceName} is ${status}`;
}

function buildPulseDeviceUrl(deviceId: string | null): string | null {
  if (!PULSE_ORG_ID || !deviceId) {
    return null;
  }

  return `https://pulse.neat.no/${PULSE_ORG_ID}/p/rooms/device/${deviceId}`;
}

function buildAlertTitle(event: ParsedEvent, status: "offline" | "online"): string {
  const base = status === "offline" ? "Device Offline" : "Device Restored";
  const place = [event.roomName, event.locationName].filter(Boolean).join(" • ");

  if (place) {
    return `${base} | ${place}`;
  }

  return `${base} | ${event.deviceName}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);

  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < leftBytes.length; i += 1) {
    diff |= leftBytes[i] ^ rightBytes[i];
  }

  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
