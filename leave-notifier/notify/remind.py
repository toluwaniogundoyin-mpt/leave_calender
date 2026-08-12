#!/usr/bin/env python3
"""
Leave notification reminder — reads data/leaves.yaml, posts due reminders to Slack.

Mirrors the shape of coralpay-balance-alert/balance_alert.py: a Slack Incoming
Webhook for output, and a git-committed JSON latch (data/notified.json) so
re-running the same day doesn't double-post. Meant to be triggered by the
GitHub Actions workflow in .github/workflows/remind.yml.
"""

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import requests
import yaml

WAT = timezone(timedelta(hours=1))  # West Africa Time (UTC+1, no DST) — matches balance_alert.py

LEAVES_FILE = os.environ.get("LEAVES_FILE", "data/leaves.yaml")
STATE_FILE = os.environ.get("NOTIFIED_FILE", "data/notified.json")
SLACK_WEBHOOK_URL = os.environ["SLACK_WEBHOOK_URL"].strip()
REMINDER_DAYS_BEFORE = int(os.environ.get("REMINDER_DAYS_BEFORE", "3"))

# reminder type -> (emoji, headline template)
_REMINDER_COPY = {
    "upcoming": (":calendar:", "Upcoming leave in {days} days"),
    "starting_today": (":palm_tree:", "Leave starts today"),
    "back_tomorrow": (":wave:", "Back from leave tomorrow"),
}


def _today() -> date:
    return datetime.now(WAT).date()


def load_leaves() -> list:
    with open(LEAVES_FILE, encoding="utf-8") as f:
        data = yaml.safe_load(f) or []
    return data


def load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"sent": []}


def save_state(state: dict) -> None:
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
        f.write("\n")


def _who(entry: dict) -> str:
    return entry.get("slack_user") or entry.get("name", "someone")


def _blocks(reminder_type: str, entry: dict, days: int) -> list:
    emoji, headline_tpl = _REMINDER_COPY[reminder_type]
    headline = headline_tpl.format(days=days)
    lines = [f"*{_who(entry)}*"]
    lines.append(f"{entry['start']} → {entry['end']}")
    if entry.get("note"):
        lines.append(f"Note: {entry['note']}")
    body = "\n".join(lines)
    return [
        {"type": "header", "text": {"type": "plain_text", "text": f"{emoji} {headline}"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": body}},
    ]


def notify(reminder_type: str, entry: dict, days: int = 0) -> None:
    emoji, headline_tpl = _REMINDER_COPY[reminder_type]
    fallback = f"{emoji} {headline_tpl.format(days=days)} — {_who(entry)} ({entry['start']} to {entry['end']})"
    r = requests.post(
        SLACK_WEBHOOK_URL,
        json={"text": fallback, "blocks": _blocks(reminder_type, entry, days)},
        timeout=20,
    )
    r.raise_for_status()


def due_reminders(entry: dict, today: date) -> list:
    """Return the list of (reminder_type, days) reminders due today for this entry."""
    start = date.fromisoformat(entry["start"])
    end = date.fromisoformat(entry["end"])
    due = []
    if (start - today).days == REMINDER_DAYS_BEFORE:
        due.append(("upcoming", REMINDER_DAYS_BEFORE))
    if start == today:
        due.append(("starting_today", 0))
    if end == today:
        due.append(("back_tomorrow", 0))
    return due


def main() -> int:
    today = _today()
    leaves = load_leaves()
    state = load_state()
    sent = set(state.get("sent", []))

    sent_count = 0
    for entry in leaves:
        entry_id = entry.get("id")
        if not entry_id:
            print(f"[warn] skipping entry with no id: {entry!r}", file=sys.stderr)
            continue
        for reminder_type, days in due_reminders(entry, today):
            key = f"{entry_id}:{reminder_type}"
            if key in sent:
                continue
            notify(reminder_type, entry, days)
            sent.add(key)
            sent_count += 1
            print(f"[info] sent {reminder_type} reminder for {entry_id} ({_who(entry)})")

    if sent_count:
        state["sent"] = sorted(sent)
        save_state(state)
        print(f"[info] sent {sent_count} reminder(s); latch updated.")
    else:
        print("[info] no reminders due.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
