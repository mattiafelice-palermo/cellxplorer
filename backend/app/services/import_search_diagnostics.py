"""Opt-in per-process JSONL tracing; never let diagnostics break indexing.

Set CELLXPLORER_INDEX_TRACE to a local directory. Source paths and error text
are recorded locally; metadata values and cycling records are not recorded.
"""
import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

_lock = threading.Lock()


def trace(event, **fields):
    directory = os.environ.get('CELLXPLORER_INDEX_TRACE')
    if not directory:
        return
    try:
        record = dict(time=datetime.now(timezone.utc).isoformat(), monotonic=time.monotonic(),
                      pid=os.getpid(), thread=threading.current_thread().name, event=event, **fields)
        with _lock:
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            with (target / f'index-{os.getpid()}.jsonl').open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(record, default=str, ensure_ascii=False) + '\n')
    except Exception:
        pass


def trace_message(event, message, spool):
    if not os.environ.get("CELLXPLORER_INDEX_TRACE"):
        return
    fields = {key: value for key, value in message.items() if key not in ('facts', 'fact')}
    facts = message.get('facts', [message['fact']] if 'fact' in message else [])
    fields['facts'] = [{key: value for key, value in fact.items() if key in ('path', 'canonical', 'extension', 'size', 'mtime_ns', 'recognition', 'metadata_state', 'metadata_version')}
                       | {'metadata_fields': sorted(fact.get('metadata', {}))} for fact in facts]
    trace(event, spool=str(spool), **fields)
