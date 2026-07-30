"""Start Cellxplorer locally: uvicorn serving API + built frontend.

    python run.py           → http://127.0.0.1:8642

Data lives in %USERPROFILE%/.cellxplorer (override with CELLXPLORER_DATA).
"""
import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "backend"))

import uvicorn

if __name__ == "__main__":
    try:
        port = int(os.environ.get("CELLXPLORER_PORT", "8642"))
    except ValueError:
        port = 8642
    if not 1 <= port <= 65535:
        port = 8642
    # Match the packaged entry point: no websocket/httptools machinery (spec 032).
    uvicorn.run(
        "app.main:app", host="127.0.0.1", port=port, log_level="info", ws="none", http="h11"
    )
