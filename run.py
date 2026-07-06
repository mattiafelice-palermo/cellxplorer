"""Start Cellxplorer locally: uvicorn serving API + built frontend.

    python run.py           → http://127.0.0.1:8642

Data lives in %USERPROFILE%/.cellxplorer (override with CELLXPLORER_DATA).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "backend"))

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8642, log_level="info")
