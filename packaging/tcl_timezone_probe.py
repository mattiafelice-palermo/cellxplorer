"""Explicit Tcl timezone parity probe, not part of ordinary startup."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tkinter


def resource_names(tcl, directory):
    """Use Tcl's filesystem API, including DLL-embedded zipfs resources."""
    names = []
    pending = [directory]
    while pending:
        current = pending.pop()
        entries = tcl.call('glob', '-nocomplain', '-directory', current, '*')
        for entry in tcl.splitlist(entries):
            path = str(entry)
            if tcl.call('file', 'isdirectory', path):
                pending.append(path)
            else:
                names.append(path[len(directory.rstrip('/')) + 1:])
    return sorted(names)


def signature(interpreter=None, names=None) -> dict:
    tcl = interpreter if interpreter is not None else tkinter.Tcl()
    # Force clock's lazy library load before inspecting its resource variables.
    # UTC is built in and does not exercise Tcl's resource loader.
    tcl.call('clock', 'format', 0, '-timezone', ':Europe/Paris')
    if names is None:
        directory = tcl.eval('set ::tcl::clock::DataDir')
        embedded = tcl.eval('info library').startswith('//zipfs:/')
        data = Path(directory)
        if getattr(sys, 'frozen', False) and not embedded:
            if data.exists():
                raise AssertionError('Loose Tcl timezone resources remain')
            names = tcl.splitlist(tcl.eval('dict keys $::tcl::clock::CellXplorerZoneScripts'))
        else:
            names = resource_names(tcl, directory)
    values = []
    for name in sorted(names):
        zone = ':' + name
        row = []
        for epoch in (-2208988800, 0, 1277942400, 1767225600, 1782864000, 1792888200, 1792891800):
            try:
                row.append(tcl.call('clock', 'format', epoch, '-timezone', zone, '-format', '%Y-%m-%d %H:%M:%S %z %Z'))
            except tkinter.TclError as exc:
                row.append(['error', str(exc), tcl.eval('set errorCode')])
        values.append([name, row])
    for zone in ('Europe/Paris', 'US/Eastern', 'UTC', ':localtime', 'EST5EDT,M3.2.0,M11.1.0', ':../UTC', ':/UTC', ':CellXplorer/Invalid_Zone'):
        try:
            epoch = tcl.call('clock', 'scan', '2026-03-28 12:34:56', '-format', '%Y-%m-%d %H:%M:%S', '-timezone', zone)
            value = tcl.call('clock', 'add', epoch, 2, 'days', '-timezone', zone)
            values.append([zone, epoch, value])
        except tkinter.TclError as exc:
            values.append([zone, 'error', str(exc), tcl.eval('set errorCode')])
    return dict(zones=len(names), sha256=hashlib.sha256(json.dumps(values, ensure_ascii=True).encode()).hexdigest())
