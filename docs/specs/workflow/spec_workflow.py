#!/usr/bin/env python3
"""Lightweight CellXplorer implementer/reviewer workflow helper.

The workflow separates three concerns:
- NNN-agent-state.json: machine-readable source of truth for turn/state.
- NNN-agent-coordination.md: timestamped append-only communication and handoffs.
- docs/specs/reviews/: canonical technical review findings.

Transitions are made before the handoff commit, so substantive work, state, and
communication are committed and pushed together once.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, NoReturn

STATE_VERSION = 1
SPECS_DIR = Path("docs/specs")
STATE_SUFFIX = "-agent-state.json"
COORDINATION_SUFFIX = "-agent-coordination.md"

IMPLEMENTER = "IMPLEMENTER"
REVIEWER = "REVIEWER"
USER = "USER"
IMPLEMENT = "IMPLEMENT"
FIX_REVIEW = "FIX_REVIEW"
REVIEW = "REVIEW"
FINAL_REVIEW = "FINAL_REVIEW"
BLOCKED = "BLOCKED"
COMPLETE = "COMPLETE"

VALID_PAIRS = {
    (IMPLEMENTER, IMPLEMENT),
    (IMPLEMENTER, FIX_REVIEW),
    (REVIEWER, REVIEW),
    (REVIEWER, FINAL_REVIEW),
    (REVIEWER, BLOCKED),
    (REVIEWER, COMPLETE),
}


class WorkflowError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise WorkflowError(message)


def git(*args: str, check: bool = True) -> str:
    p = subprocess.run(["git", *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode != 0:
        fail(p.stderr.strip() or p.stdout.strip() or f"git {' '.join(args)} failed")
    return p.stdout.strip()


def root() -> Path:
    value = git("rev-parse", "--show-toplevel")
    if not value:
        fail("Not inside a Git repository.")
    return Path(value)


def branch() -> str:
    value = git("branch", "--show-current")
    if not value:
        fail("Detached HEAD is not supported.")
    return value


def spec_number(value: str) -> str:
    if not re.fullmatch(r"\d+", value.strip()):
        fail(f"Invalid spec number: {value!r}")
    return value.strip().zfill(3)


def now() -> str:
    return datetime.now().astimezone().replace(microsecond=0).isoformat()


def state_path(repo: Path, spec: str) -> Path:
    return repo / SPECS_DIR / f"{spec}{STATE_SUFFIX}"


def coordination_path(repo: Path, spec: str) -> Path:
    return repo / SPECS_DIR / f"{spec}{COORDINATION_SUFFIX}"


def discover_children(repo: Path, spec: str) -> list[str]:
    pattern = re.compile(rf"^{re.escape(spec)}\.(\d+)-.+\.md$")
    found: list[tuple[int, str]] = []
    directory = repo / SPECS_DIR
    if not directory.exists():
        return []
    for path in directory.iterdir():
        m = pattern.match(path.name)
        if m:
            n = int(m.group(1))
            found.append((n, f"{spec}.{n}"))
    return [child for _, child in sorted(found)]


def discover_proto_children(repo: Path, spec: str) -> list[str]:
    """Return planning-only proto-children; they never enter workflow children automatically."""
    pattern = re.compile(rf"^{re.escape(spec)}\.P(\d+)-.+\.md$")
    found: list[tuple[int, str]] = []
    directory = repo / SPECS_DIR
    if not directory.exists():
        return []
    for path in directory.iterdir():
        m = pattern.match(path.name)
        if m:
            n = int(m.group(1))
            found.append((n, f"{spec}.P{n}"))
    return [child for _, child in sorted(found)]


def normalize_state(data: dict[str, Any]) -> dict[str, Any]:
    """Add backward-compatible metadata fields introduced after state version 1."""
    data.setdefault("user_message_seq", 0)
    data.setdefault("pending_user_messages", [])
    return data


def validate(data: dict[str, Any], path: Path) -> None:
    required = {
        "version",
        "spec",
        "branch",
        "active_child",
        "children",
        "turn",
        "action",
        "findings",
        "resume_review",
        "user_message_seq",
        "pending_user_messages",
        "updated_at",
    }
    missing = required - set(data)
    if missing:
        fail(f"{path} missing fields: {', '.join(sorted(missing))}")
    if data["version"] != STATE_VERSION:
        fail(f"Unsupported workflow state version {data['version']} in {path}")
    if (data["turn"], data["action"]) not in VALID_PAIRS:
        fail(f"Invalid TURN/ACTION: {data['turn']} + {data['action']}")
    if (
        not isinstance(data["children"], list)
        or not data["children"]
        or data["active_child"] not in data["children"]
    ):
        fail("Invalid children/active_child state.")
    if not isinstance(data["findings"], list) or not all(
        isinstance(x, str) and re.fullmatch(r"R\d+", x) for x in data["findings"]
    ):
        fail("Invalid findings list.")
    if data["resume_review"] not in (None, REVIEW, FINAL_REVIEW):
        fail("Invalid resume_review state.")
    if not isinstance(data["user_message_seq"], int) or data["user_message_seq"] < 0:
        fail("Invalid user_message_seq state.")
    pending = data["pending_user_messages"]
    if not isinstance(pending, list):
        fail("Invalid pending_user_messages state.")
    seen: set[str] = set()
    for item in pending:
        if not isinstance(item, dict):
            fail("Invalid pending user message metadata.")
        message_id = item.get("id")
        timestamp = item.get("timestamp")
        if not isinstance(message_id, str) or not re.fullmatch(r"U\d+", message_id):
            fail("Invalid pending user message id.")
        if message_id in seen:
            fail("Duplicate pending user message id.")
        seen.add(message_id)
        if not isinstance(timestamp, str) or not timestamp.strip():
            fail("Invalid pending user message timestamp.")


def load(path: Path) -> dict[str, Any]:
    if not path.exists():
        fail(f"Workflow state not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"Could not read {path}: {exc}")
    normalize_state(data)
    validate(data, path)
    return data


def save(path: Path, data: dict[str, Any]) -> None:
    normalize_state(data)
    validate(data, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def create_coordination(path: Path, spec: str) -> None:
    path.write_text(
        f"# Spec {spec} Agent Coordination\n\n"
        "This file is the append-only communication and handoff log between the user, "
        "implementer, and reviewer.\n\n"
        f"- Workflow state is authoritative in `{spec}{STATE_SUFFIX}`.\n"
        "- Detailed technical findings are authoritative in `reviews/`.\n"
        "- User message bodies live here; state stores only pending message IDs/timestamps.\n"
        "- Entries are appended by `spec_workflow.py`; do not rewrite old entries.\n\n"
        "## Handoff log\n\n",
        encoding="utf-8",
    )


def append_entry(
    path: Path,
    *,
    timestamp: str,
    actor: str,
    recipient: str | None,
    child: str,
    result: str,
    verification: list[str] | None = None,
    findings: list[str] | None = None,
    user_messages: list[str] | None = None,
    message: str | None = None,
) -> None:
    if not path.exists():
        fail(f"Coordination file not found: {path}")
    direction = actor if recipient is None else f"{actor} → {recipient}"
    lines = [f"### {timestamp} — {direction} — {child}", "", f"**Result:** {result}", ""]
    if verification is not None:
        lines += ["**Verification**", ""]
        lines += [f"- {item}" for item in verification] if verification else ["- Not reported."]
        lines.append("")
    if findings is not None:
        lines += ["**Findings**", ""]
        lines += [f"- {item}" for item in findings] if findings else ["- None."]
        lines.append("")
    if user_messages is not None:
        lines += ["**User messages considered**", ""]
        lines += [f"- {item}" for item in user_messages] if user_messages else ["- None."]
        lines.append("")
    lines += ["**Message**", "", (message or "").strip() or "None.", "", "---", ""]
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines))


def resolve(repo: Path, requested: str | None) -> tuple[Path, Path, dict[str, Any]]:
    if requested:
        spec = spec_number(requested)
        sp = state_path(repo, spec)
        return sp, coordination_path(repo, spec), load(sp)
    candidates = (
        sorted((repo / SPECS_DIR).glob(f"*{STATE_SUFFIX}"))
        if (repo / SPECS_DIR).exists()
        else []
    )
    active: list[Path] = []
    terminal: list[Path] = []
    for path in candidates:
        try:
            data = load(path)
        except WorkflowError:
            continue
        (terminal if data["action"] in {BLOCKED, COMPLETE} else active).append(path)
    choices = active or terminal
    if len(choices) != 1:
        fail("Pass --spec NNN when zero or multiple workflow states are available.")
    sp = choices[0]
    data = load(sp)
    return sp, coordination_path(repo, data["spec"]), data


def assert_branch(data: dict[str, Any]) -> None:
    current = branch()
    if current != data["branch"]:
        fail(f"Workflow branch is {data['branch']!r}; current branch is {current!r}.")


def assert_workflow_files_clean(repo: Path, sp: Path, cp: Path) -> None:
    for path in (sp, cp):
        rel = path.relative_to(repo).as_posix()
        if git("status", "--porcelain", "--", rel):
            fail(f"{rel} already has an uncommitted workflow change. Commit/push it first.")


def assert_transition_ready(
    repo: Path,
    sp: Path,
    cp: Path,
    data: dict[str, Any],
    *,
    allow_blocked: bool = False,
) -> None:
    assert_branch(data)
    if data["action"] == COMPLETE:
        fail("Workflow is already COMPLETE.")
    if data["action"] == BLOCKED and not allow_blocked:
        fail("Workflow is BLOCKED. Use resume-final-review when the external dependency is available.")
    assert_workflow_files_clean(repo, sp, cp)


def normalize_findings(values: list[str]) -> list[str]:
    found: set[str] = set()
    for value in values:
        value = value.strip().upper()
        if not re.fullmatch(r"R\d+", value):
            fail(f"Invalid finding {value!r}; expected R1, R2, ...")
        found.add(value)
    return sorted(found, key=lambda x: int(x[1:]))


def clean(values: list[str] | None) -> list[str]:
    return [x.strip() for x in (values or []) if x.strip()]


def following_child(data: dict[str, Any]) -> str | None:
    i = data["children"].index(data["active_child"])
    return data["children"][i + 1] if i + 1 < len(data["children"]) else None


def pending_user_message_ids(data: dict[str, Any]) -> list[str]:
    return [str(item["id"]) for item in data["pending_user_messages"]]


def consume_user_messages(data: dict[str, Any]) -> list[str]:
    ids = pending_user_message_ids(data)
    data["pending_user_messages"] = []
    return ids


def status_text(sp: Path, cp: Path, data: dict[str, Any]) -> None:
    findings = ", ".join(data["findings"]) if data["findings"] else "NONE"
    pending = data["pending_user_messages"]
    repo = root()
    print(f"SPEC: {data['spec']}")
    print(f"BRANCH: {data['branch']}")
    print(f"ACTIVE_CHILD: {data['active_child']}")
    print(f"TURN: {data['turn']}")
    print(f"ACTION: {data['action']}")
    print(f"FINDINGS: {findings}")
    print(f"USER_MESSAGES_PENDING: {len(pending)}")
    if pending:
        detail = ", ".join(f"{item['id']}={item['timestamp']}" for item in pending)
        print(f"USER_MESSAGE_TIMESTAMPS: {detail}")
    else:
        print("USER_MESSAGE_TIMESTAMPS: NONE")
    proto = discover_proto_children(repo, data["spec"])
    print(f"PROTO_CHILDREN: {', '.join(proto) if proto else 'NONE'}")
    print(f"STATE_FILE: {sp.relative_to(repo)}")
    print(f"COORDINATION_FILE: {cp.relative_to(repo)}")


def cmd_init(args: argparse.Namespace) -> None:
    repo = root()
    spec = spec_number(args.spec)
    sp, cp = state_path(repo, spec), coordination_path(repo, spec)
    if (sp.exists() or cp.exists()) and not args.force:
        fail("Workflow files already exist. Use --force only intentionally.")
    current = branch()
    expected = args.branch or current
    if current != expected:
        fail(f"Current branch {current!r} does not match requested branch {expected!r}.")
    children = args.children or discover_children(repo, spec) or [spec]
    active = args.start_child or children[0]
    if active not in children:
        fail(f"Start child {active!r} is not in the child list.")
    ts = now()
    data = {
        "version": STATE_VERSION,
        "spec": spec,
        "branch": current,
        "active_child": active,
        "children": children,
        "turn": IMPLEMENTER,
        "action": IMPLEMENT,
        "findings": [],
        "resume_review": None,
        "user_message_seq": 0,
        "pending_user_messages": [],
        "updated_at": ts,
    }
    save(sp, data)
    create_coordination(cp, spec)
    append_entry(
        cp,
        timestamp=ts,
        actor=REVIEWER,
        recipient=IMPLEMENTER,
        child=active,
        result="Workflow initialized",
        message=args.message,
    )
    status_text(sp, cp, data)


def cmd_status(args: argparse.Namespace) -> None:
    repo = root()
    sp, cp, data = resolve(repo, args.spec)
    assert_branch(data)
    print(json.dumps(data, indent=2) if args.json else "", end="" if args.json else "")
    if not args.json:
        status_text(sp, cp, data)


def cmd_user_message(args: argparse.Namespace) -> None:
    repo = root()
    sp, cp, data = resolve(repo, args.spec)
    assert_branch(data)
    assert_workflow_files_clean(repo, sp, cp)
    message = (args.message or "").strip()
    if not message:
        fail("user-message requires --message with the instruction or input for the reviewer.")
    if data["action"] == COMPLETE:
        fail("Workflow is COMPLETE; start or reopen a workflow instead of adding a pending review message.")
    ts = now()
    data["user_message_seq"] += 1
    message_id = f"U{data['user_message_seq']}"
    data["pending_user_messages"].append({"id": message_id, "timestamp": ts})
    data["updated_at"] = ts
    save(sp, data)
    append_entry(
        cp,
        timestamp=ts,
        actor=USER,
        recipient=REVIEWER,
        child=data["active_child"],
        result=f"User input {message_id}",
        message=message,
    )
    print(f"USER_MESSAGE: {message_id}")
    print(f"TIMESTAMP: {ts}")
    print(f"PENDING: {len(data['pending_user_messages'])}")


def cmd_add_child(args: argparse.Namespace) -> None:
    repo = root()
    sp, cp, data = resolve(repo, args.spec)
    assert_transition_ready(repo, sp, cp, data)
    if data["turn"] != REVIEWER or data["action"] not in {REVIEW, FINAL_REVIEW}:
        fail("add-child is reviewer-controlled and valid only during REVIEW or FINAL_REVIEW.")
    child = args.child.strip()
    if not re.fullmatch(rf"{re.escape(data['spec'])}\.\d+", child):
        fail(f"Invalid child {child!r}; expected {data['spec']}.N.")
    if child in data["children"]:
        fail(f"Child {child} is already scheduled.")
    matches = list((repo / SPECS_DIR).glob(f"{child}-*.md"))
    if len(matches) != 1:
        fail(f"Expected exactly one authored child spec matching {child}-*.md before scheduling it.")
    child_number = int(child.split(".", 1)[1])
    existing_numbers = [int(item.split(".", 1)[1]) for item in data["children"] if "." in item]
    if child_number in existing_numbers:
        fail(f"Child number {child_number} is already represented in workflow state.")
    active_number = (
        int(data["active_child"].split(".", 1)[1])
        if "." in data["active_child"]
        else 0
    )
    if child_number <= active_number:
        fail(
            f"Promoted child {child} must come after active child {data['active_child']}; "
            "completed/active child numbers cannot be inserted retroactively."
        )
    data["children"].append(child)
    data["children"].sort(key=lambda item: int(item.split(".", 1)[1]) if "." in item else 0)
    ts = now()
    considered = consume_user_messages(data)
    if data["action"] == FINAL_REVIEW:
        data.update(
            active_child=child,
            turn=IMPLEMENTER,
            action=IMPLEMENT,
            findings=[],
            resume_review=None,
            updated_at=ts,
        )
        recipient = IMPLEMENTER
        result = f"Scheduled promoted child {child}; returning to implementation"
    else:
        data["updated_at"] = ts
        recipient = None
        result = f"Scheduled promoted child {child} after current review sequence"
    save(sp, data)
    append_entry(
        cp,
        timestamp=ts,
        actor=REVIEWER,
        recipient=recipient,
        child=data["active_child"],
        result=result,
        user_messages=considered,
        message=args.message,
    )


def cmd_handoff_review(args: argparse.Namespace) -> None:
    repo = root()
    sp, cp, data = resolve(repo, args.spec)
    assert_transition_ready(repo, sp, cp, data)
    if data["turn"] != IMPLEMENTER or data["action"] not in {IMPLEMENT, FIX_REVIEW}:
        fail("handoff-review is only valid for IMPLEMENTER + IMPLEMENT/FIX_REVIEW.")
    previous = data["action"]
    return_action = (
        data["resume_review"] if previous == FIX_REVIEW and data["resume_review"] else REVIEW
    )
    ts = now()
    data.update(turn=REVIEWER, action=return_action, updated_at=ts)
    save(sp, data)
    append_entry(
        cp,
        timestamp=ts,
        actor=IMPLEMENTER,
        recipient=REVIEWER,
        child=data["active_child"],
        result="Review fixes ready" if previous == FIX_REVIEW else "Implementation ready",
        verification=clean(args.verification),
        message=args.message,
    )


def cmd_request_fixes(args: argparse.Namespace) -> None:
    repo = root()
    sp, cp, data = resolve(repo, args.spec)
    assert_transition_ready(repo, sp, cp, data)
    if data["turn"] != REVIEWER or data["action"] not in {REVIEW, FINAL_REVIEW}:
        fail("request-fixes is only valid during REVIEW/FINAL_REVIEW.")
    findings = normalize_findings(args.findings)
    considered = consume_user_messages(data)
    ts = now()
    resume = data["action"]
    data.update(
        turn=IMPLEMENTER,
        action=FIX_REVIEW,
        findings=findings,
        resume_review=resume,
        updated_at=ts,
    )
    save(sp, data)
    append_entry(
        cp,
        timestamp=ts,
        actor=REVIEWER,
        recipient=IMPLEMENTER,
        child=data["active_child"],
        result="Changes required",
        findings=findings,
        user_messages=considered,
        message=args.message,
    )


def cmd_review_clean(args: argparse.Namespace) -> None:
    repo = root()
    sp, cp, data = resolve(repo, args.spec)
    assert_transition_ready(repo, sp, cp, data)
    if (data["turn"], data["action"]) != (REVIEWER, REVIEW):
        fail("review-clean is only valid for REVIEWER + REVIEW.")
    considered = consume_user_messages(data)
    completed = data["active_child"]
    nxt = following_child(data)
    ts = now()
    if nxt is None:
        data.update(action=FINAL_REVIEW, findings=[], resume_review=None, updated_at=ts)
        recipient = None
        result = "Child review clean; entering final parent review"
    else:
        data.update(
            active_child=nxt,
            turn=IMPLEMENTER,
            action=IMPLEMENT,
            findings=[],
            resume_review=None,
            updated_at=ts,
        )
        recipient = IMPLEMENTER
        result = f"Review clean; next child {nxt}"
    save(sp, data)
    append_entry(
        cp,
        timestamp=ts,
        actor=REVIEWER,
        recipient=recipient,
        child=completed,
        result=result,
        findings=[],
        user_messages=considered,
        message=args.message,
    )


def cmd_block(args: argparse.Namespace) -> None:
    repo = root()
    sp, cp, data = resolve(repo, args.spec)
    assert_transition_ready(repo, sp, cp, data)
    if (data["turn"], data["action"]) != (REVIEWER, FINAL_REVIEW):
        fail("block is only valid for REVIEWER + FINAL_REVIEW.")
    message = (args.message or "").strip()
    if not message:
        fail("block requires --message describing the external dependency.")
    considered = consume_user_messages(data)
    ts = now()
    data.update(action=BLOCKED, findings=[], resume_review=None, updated_at=ts)
    save(sp, data)
    append_entry(
        cp,
        timestamp=ts,
        actor=REVIEWER,
        recipient=None,
        child=data["active_child"],
        result="Final review blocked on external dependency",
        findings=[],
        user_messages=considered,
        message=message,
    )


def cmd_resume_final_review(args: argparse.Namespace) -> None:
    repo = root()
    sp, cp, data = resolve(repo, args.spec)
    assert_transition_ready(repo, sp, cp, data, allow_blocked=True)
    if (data["turn"], data["action"]) != (REVIEWER, BLOCKED):
        fail("resume-final-review is only valid for REVIEWER + BLOCKED.")
    considered = consume_user_messages(data)
    ts = now()
    data.update(action=FINAL_REVIEW, findings=[], resume_review=None, updated_at=ts)
    save(sp, data)
    append_entry(
        cp,
        timestamp=ts,
        actor=REVIEWER,
        recipient=None,
        child=data["active_child"],
        result="External dependency available; resuming final parent review",
        findings=[],
        user_messages=considered,
        message=args.message,
    )


def cmd_complete(args: argparse.Namespace) -> None:
    repo = root()
    sp, cp, data = resolve(repo, args.spec)
    assert_transition_ready(repo, sp, cp, data)
    if (data["turn"], data["action"]) != (REVIEWER, FINAL_REVIEW):
        fail("complete is only valid after the cumulative parent review.")
    considered = consume_user_messages(data)
    ts = now()
    data.update(action=COMPLETE, findings=[], resume_review=None, updated_at=ts)
    save(sp, data)
    append_entry(
        cp,
        timestamp=ts,
        actor=REVIEWER,
        recipient=None,
        child=data["active_child"],
        result="Cumulative parent review clean; workflow complete",
        findings=[],
        user_messages=considered,
        message=args.message,
    )


def add_spec(p: argparse.ArgumentParser) -> None:
    p.add_argument("--spec")


def add_message(p: argparse.ArgumentParser) -> None:
    p.add_argument("--message")


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="CellXplorer spec implementer/reviewer workflow helper.")
    sub = p.add_subparsers(dest="command", required=True)
    x = sub.add_parser("init")
    x.add_argument("spec")
    x.add_argument("--branch")
    x.add_argument("--children", nargs="+")
    x.add_argument("--start-child")
    x.add_argument("--force", action="store_true")
    add_message(x)
    x.set_defaults(func=cmd_init)
    x = sub.add_parser("status")
    add_spec(x)
    x.add_argument("--json", action="store_true")
    x.set_defaults(func=cmd_status)
    x = sub.add_parser("user-message")
    add_spec(x)
    add_message(x)
    x.set_defaults(func=cmd_user_message)
    x = sub.add_parser("add-child")
    x.add_argument("child")
    add_spec(x)
    add_message(x)
    x.set_defaults(func=cmd_add_child)
    x = sub.add_parser("handoff-review")
    add_spec(x)
    x.add_argument("--verification", action="append", default=[])
    add_message(x)
    x.set_defaults(func=cmd_handoff_review)
    x = sub.add_parser("request-fixes")
    x.add_argument("findings", nargs="+")
    add_spec(x)
    add_message(x)
    x.set_defaults(func=cmd_request_fixes)
    x = sub.add_parser("review-clean")
    add_spec(x)
    add_message(x)
    x.set_defaults(func=cmd_review_clean)
    x = sub.add_parser("block")
    add_spec(x)
    add_message(x)
    x.set_defaults(func=cmd_block)
    x = sub.add_parser("resume-final-review")
    add_spec(x)
    add_message(x)
    x.set_defaults(func=cmd_resume_final_review)
    x = sub.add_parser("complete")
    add_spec(x)
    add_message(x)
    x.set_defaults(func=cmd_complete)
    return p


def main() -> int:
    args = parser().parse_args()
    try:
        args.func(args)
        return 0
    except WorkflowError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
