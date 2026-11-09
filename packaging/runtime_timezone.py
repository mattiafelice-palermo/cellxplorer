"""Expose archive-backed tzdata before application imports and frozen children."""
import os
import sys

if getattr(sys, "frozen", False):
    archive = os.path.join(sys._MEIPASS, "tzdata.zip")
    if not os.path.isfile(archive):
        raise RuntimeError("Packaged timezone archive is missing")
    sys.path.insert(0, archive)
