import yaml from "js-yaml";

const USAGE =
  "Usage:\n" +
  "`/leaves add @user YYYY-MM-DD YYYY-MM-DD [note]` — add a leave record\n" +
  "`/leaves check` — list current + upcoming leave for the whole team (next 30 days)";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MENTION_RE = /^<@([A-Z0-9]+)(\|[^>]+)?>$/i;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const bodyText = await request.text();
    const timestamp = request.headers.get("X-Slack-Request-Timestamp") || "";
    const signature = request.headers.get("X-Slack-Signature") || "";

    const verified = await verifySlackSignature(
      env.SLACK_SIGNING_SECRET,
      timestamp,
      bodyText,
      signature
    );
    if (!verified) {
      return new Response("Invalid signature", { status: 401 });
    }

    const params = new URLSearchParams(bodyText);
    const text = (params.get("text") || "").trim();
    const invokedBy = params.get("user_id") ? `<@${params.get("user_id")}>` : "someone";

    try {
      const reply = await handleCommand(text, invokedBy, env);
      return jsonResponse(reply);
    } catch (err) {
      return jsonResponse({
        response_type: "ephemeral",
        text: `:warning: ${err.message || "Something went wrong."}`,
      });
    }
  },
};

async function handleCommand(text, invokedBy, env) {
  const [subcommand, ...rest] = text.split(/\s+/).filter(Boolean);

  if (subcommand === "check" || subcommand === "list") {
    return checkLeaves(env);
  }
  if (subcommand === "add") {
    return addLeave(rest, invokedBy, env);
  }
  return {
    response_type: "ephemeral",
    text: USAGE,
  };
}

async function addLeave(args, invokedBy, env) {
  const [userToken, start, end, ...noteParts] = args;
  if (!userToken || !start || !end) {
    return { response_type: "ephemeral", text: `Missing arguments.\n${USAGE}` };
  }

  const mentionMatch = MENTION_RE.exec(userToken);
  const slackUser = mentionMatch ? `<@${mentionMatch[1]}>` : null;
  const name = slackUser || userToken.replace(/^@/, "");

  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return { response_type: "ephemeral", text: `Dates must be YYYY-MM-DD.\n${USAGE}` };
  }
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { response_type: "ephemeral", text: `Could not parse those dates.\n${USAGE}` };
  }
  if (endDate < startDate) {
    return { response_type: "ephemeral", text: "End date must be on or after the start date." };
  }

  const entry = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    slack_user: slackUser,
    start,
    end,
    note: noteParts.join(" ") || null,
    added_by: invokedBy,
    added_at: new Date().toISOString(),
  };

  await appendLeaveWithRetry(entry, env);

  return {
    response_type: "in_channel",
    text: `:calendar: Added leave for ${name}: ${start} → ${end}${entry.note ? ` (${entry.note})` : ""}`,
  };
}

async function checkLeaves(env) {
  const { leaves } = await fetchLeaves(env);
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const horizon = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  const upcoming = leaves
    .filter((e) => new Date(`${e.end}T00:00:00Z`) >= today && new Date(`${e.start}T00:00:00Z`) <= horizon)
    .sort((a, b) => a.start.localeCompare(b.start));

  if (upcoming.length === 0) {
    return { response_type: "in_channel", text: "No current or upcoming leave in the next 30 days." };
  }

  const lines = upcoming.map((e) => {
    const who = e.slack_user || e.name;
    const note = e.note ? ` — ${e.note}` : "";
    return `• *${who}*: ${e.start} → ${e.end}${note}`;
  });

  return {
    response_type: "in_channel",
    text: `:calendar: *Current & upcoming leave (next 30 days)*\n${lines.join("\n")}`,
  };
}

async function fetchLeaves(env) {
  const res = await githubRequest(env, "GET");
  if (res.status === 404) {
    return { leaves: [], sha: null };
  }
  if (!res.ok) {
    throw new Error(`GitHub read failed (${res.status})`);
  }
  const body = await res.json();
  const content = fromBase64(body.content);
  const leaves = yaml.load(content) || [];
  return { leaves, sha: body.sha };
}

async function appendLeaveWithRetry(entry, env, attempt = 0) {
  const { leaves, sha } = await fetchLeaves(env);
  leaves.push(entry);
  const newContent = yaml.dump(leaves, { noRefs: true });

  const res = await githubRequest(env, "PUT", {
    message: `leave: add ${entry.name} (${entry.start} to ${entry.end})`,
    content: toBase64(newContent),
    sha: sha || undefined,
    branch: env.GITHUB_BRANCH,
  });

  if (res.status === 409 && attempt === 0) {
    return appendLeaveWithRetry(entry, env, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`GitHub write failed (${res.status})`);
  }
}

async function githubRequest(env, method, jsonBody) {
  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.LEAVES_PATH}` +
    (method === "GET" ? `?ref=${env.GITHUB_BRANCH}` : "");
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "leave-notifier-worker",
      "Content-Type": "application/json",
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
}

async function verifySlackSignature(signingSecret, timestamp, body, signature) {
  if (!signingSecret || !timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (Number.isNaN(age) || age > 60 * 5) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = `v0=${hex}`;

  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}
