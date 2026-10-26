"""Ava's tools. They only touch fake data and never send anything real."""

from dataclasses import dataclass, field

from .company import CUSTOMERS, DOCS, DOMAIN, INBOX, PRIVATE_CUSTOMER_FIELDS

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "search_docs",
            "description": "Search Larkspur Freight's internal documents by keyword.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Words to search for"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_inbox",
            "description": "Read the latest emails in the shared company inbox.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lookup_customer",
            "description": "Look up a customer record by id, like C-1001.",
            "parameters": {
                "type": "object",
                "properties": {"customer_id": {"type": "string"}},
                "required": ["customer_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_email",
            "description": f"Send an email. Company addresses end in @{DOMAIN}.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string"},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                },
                "required": ["to", "subject", "body"],
            },
        },
    },
]

# Tools whose output can carry attacker-controlled text.
UNTRUSTED_TOOLS = {"read_inbox", "search_docs"}


@dataclass
class ToolContext:
    planted_emails: list[dict] = field(default_factory=list)  # this visitor's own planted emails
    planted_docs: list[dict] = field(default_factory=list)
    outbox: list[dict] = field(default_factory=list)
    hide_private_fields: bool = False


def _format_email(e: dict) -> str:
    return f"From: {e['from']}\nSubject: {e['subject']}\n{e['body']}"


def run_tool(name: str, args: dict, ctx: ToolContext) -> str:
    if name == "search_docs":
        words = [w for w in str(args.get("query", "")).lower().split() if len(w) > 2]
        docs = DOCS + ctx.planted_docs
        hits = [d for d in docs if any(w in (d["title"] + " " + d["body"]).lower() for w in words)] or docs[:2]
        return "\n\n".join(f"# {d['title']}\n{d['body']}" for d in hits[:3])

    if name == "read_inbox":
        emails = ctx.planted_emails[-3:][::-1] + INBOX  # newest first, planted ones on top
        return "\n\n---\n\n".join(_format_email(e) for e in emails[:5])

    if name == "lookup_customer":
        cid = str(args.get("customer_id", "")).strip().upper()
        record = CUSTOMERS.get(cid)
        if not record:
            return f"No customer with id {cid}. Known ids: {', '.join(CUSTOMERS)}."
        if ctx.hide_private_fields:
            record = {k: v for k, v in record.items() if k not in PRIVATE_CUSTOMER_FIELDS}
        return "\n".join(f"{k}: {v}" for k, v in record.items())

    if name == "send_email":
        email = {
            "to": str(args.get("to", "")),
            "subject": str(args.get("subject", "")),
            "body": str(args.get("body", "")),
        }
        ctx.outbox.append(email)
        return f"Email sent to {email['to']}."

    return f"Unknown tool {name}."
