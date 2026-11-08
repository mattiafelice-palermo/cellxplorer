"""Bounded header-only processes; the coordinator alone publishes catalog facts."""
from __future__ import annotations

from contextlib import ExitStack
from collections import deque
import multiprocessing
import logging
from pathlib import Path
import queue
import threading
import time

from .import_search_diagnostics import trace
from .import_search_transport import BatchSpool, scan_spool
from .import_search_worker import inspect_fact

MAX_HEADER_READERS = 4
_slots = threading.BoundedSemaphore(MAX_HEADER_READERS)
_retiring = {}
_retiring_lock = threading.Lock()


def _close_lane(lane):
    lane["process"].join(0)
    lane["process"].close()  # Only after confirmed exit; close rejects a live child.
    try:
        lane["resources"].close()
    except OSError as error:
        trace("header_spool_cleanup_deferred", error=repr(error))
    finally:
        _slots.release()


def _reap_lane(lane):
    """Retain process, spool and capacity ownership through delayed Windows exit."""
    while True:
        try:
            if lane["process"].is_alive():
                lane["process"].kill()
                lane["process"].join(0.1)
                continue
            _close_lane(lane)
            with _retiring_lock:
                _retiring.pop(id(lane), None)
            return
        except (OSError, ValueError) as error:
            trace("header_reaper_retry", error=repr(error))
            time.sleep(0.1)


def _stop_lane(lane):
    if lane.get("retired"):
        return
    lane["retired"] = True
    process = lane["process"]
    try:
        if process.is_alive():
            process.terminate()
        process.join(0.1)
        if process.is_alive():
            process.kill()
            process.join(0.1)
        if not process.is_alive():
            _close_lane(lane)
            return
    except (OSError, ValueError) as error:
        trace("header_cleanup_deferred", error=repr(error))
    # Never close a live process or abandon sibling cleanup. A delayed child keeps
    # its global reader slot, so a replacement cannot exceed the four-process cap.
    with _retiring_lock:
        _retiring[id(lane)] = lane
    threading.Thread(target=_reap_lane, args=(lane,), name="source-header-reaper", daemon=True).start()


def header_reader(incoming: str, outgoing: str, metadata_enabled: bool):
    """One request at a time; no catalog connection or nested children."""
    logging.disable(logging.CRITICAL)
    requests, results = BatchSpool(incoming), BatchSpool(outgoing)
    while True:
        try:
            request = requests.get(timeout=0.1)
        except (queue.Empty, PermissionError):
            continue
        results.put(dict(kind="started", canonical=request["fact"]["canonical"]))
        results.put(dict(kind="result", fact=inspect_fact(request["fact"], metadata_enabled)))


def unavailable(fact):
    return dict(fact, metadata_state="unavailable", metadata={}, metadata_version=0)


def read_headers(facts, *, readers, metadata_enabled, timeout, cancelled, reader=header_reader):
    """Yield one outcome per fact, with at most `readers` outstanding requests.

    Deadlines start at dispatch (including process startup). No heartbeat, sibling
    completion or spool-access retry can extend them. After observing worker exit,
    drain its final frame before classifying failure. Closing the generator kills
    every lane, including processes blocked in a network or native reader call.
    """
    if not 1 <= readers <= MAX_HEADER_READERS:
        raise ValueError("Use between one and four header readers")
    context = multiprocessing.get_context("spawn")
    source = iter(facts)
    lanes = []
    pending = deque()

    def start(fact):
        with ExitStack() as owned:
            directory = Path(owned.enter_context(scan_spool("headers-")))
            incoming, outgoing = directory / "in", directory / "out"
            incoming.mkdir()
            outgoing.mkdir()
            process = context.Process(target=reader, args=(str(incoming), str(outgoing), metadata_enabled), daemon=True)
            try:
                process.start()
            except BaseException:
                process.close()
                raise
            return dict(process=process, requests=BatchSpool(str(incoming)), results=BatchSpool(str(outgoing)),
                        fact=fact, resources=owned.pop_all())

    try:
        exhausted = False
        waiting_since = None
        while not cancelled():
            # Refill only empty slots: no unbounded executor queue or fact list.
            while (pending or not exhausted) and len(lanes) < readers:
                fact, started, retries = pending.popleft() if pending else (next(source, None), None, 0)
                if fact is None:
                    exhausted = True
                    break
                if not _slots.acquire(blocking=False):
                    pending.appendleft((fact, started, retries))
                    break
                started = time.monotonic() if started is None else started
                try:
                    lane = start(fact)
                except BaseException:
                    _slots.release()
                    raise
                lanes.append(lane)
                lane["started"] = started
                lane["retries"] = retries
                lane["announced"] = False
                lane["sent"] = False
                trace("header_dispatch", canonical=fact["canonical"], reader_pid=lane["process"].pid)
            if not lanes:
                if exhausted and not pending:
                    return
                waiting_since = time.monotonic() if waiting_since is None else waiting_since
                retry_expired = pending and pending[0][1] is not None and time.monotonic() - pending[0][1] >= timeout
                if time.monotonic() - waiting_since >= timeout or retry_expired:
                    raise RuntimeError("Previous header readers are still stopping")
                time.sleep(0.01)
                continue
            waiting_since = None
            progressed = False
            for lane in list(lanes):
                if cancelled():
                    return
                fact, process = lane["fact"], lane["process"]
                if not lane["sent"]:
                    try:
                        # Local locks yield back to cancellation and sibling deadlines.
                        lane["requests"].put(dict(fact=fact), retry_seconds=0)
                        lane["sent"] = True
                    except PermissionError:
                        if time.monotonic() - lane["started"] < timeout:
                            continue
                try:
                    message = lane["results"].get(timeout=0)
                except (queue.Empty, PermissionError) as first_error:
                    # Death and an empty poll are independent observations.
                    dead = not process.is_alive()
                    if dead:
                        try:
                            message = lane["results"].get(timeout=0)
                        except (queue.Empty, PermissionError) as final_error:
                            if (isinstance(first_error, PermissionError) or isinstance(final_error, PermissionError)) and time.monotonic() - lane["started"] < timeout:
                                continue
                            message = None
                    else:
                        message = None
                    if message is None:
                        if not dead and time.monotonic() - lane["started"] < timeout:
                            continue
                        trace("header_reader_failed", canonical=fact["canonical"], reader_pid=process.pid,
                              reason="exit" if dead else "timeout", exitcode=process.exitcode)
                        _stop_lane(lane)
                        lanes.remove(lane)
                        if not lane["announced"]:
                            # A process may exit after its last result but before
                            # accepting another request. Do not blame the next file.
                            if dead and lane["retries"] == 0 and time.monotonic() - lane["started"] < timeout:
                                pending.appendleft((fact, lane["started"], 1))
                                progressed = True
                                continue
                            raise RuntimeError("Header reader failed before starting its assigned source")
                        yield unavailable(fact)
                        progressed = True
                        continue
                if message["kind"] == "started":
                    if message["canonical"] != fact["canonical"]:
                        raise ValueError("Header reader started a different source")
                    lane["announced"] = True
                    progressed = True
                    continue
                if time.monotonic() - lane["started"] >= timeout:
                    trace("header_reader_failed", canonical=fact["canonical"], reader_pid=process.pid,
                          reason="timeout", exitcode=process.exitcode)
                    _stop_lane(lane)
                    lanes.remove(lane)
                    yield unavailable(fact)
                    progressed = True
                    continue
                result = message["fact"]
                if message["kind"] != "result" or result["canonical"] != fact["canonical"]:
                    raise ValueError("Header reader returned a different source")
                yield result
                progressed = True
                if not process.is_alive():
                    _stop_lane(lane)
                    lanes.remove(lane)
                    continue
                following, started, retries = pending.popleft() if pending else (next(source, None), None, 0)
                if following is None:
                    _stop_lane(lane)
                    lanes.remove(lane)
                    exhausted = True
                else:
                    lane["fact"] = following
                    lane["started"] = time.monotonic() if started is None else started
                    lane["sent"] = False
                    lane["announced"] = False
                    lane["retries"] = retries
                    trace("header_dispatch", canonical=following["canonical"], reader_pid=process.pid)
            if not progressed:
                time.sleep(0.01)
    finally:
        for lane in lanes:
            _stop_lane(lane)
