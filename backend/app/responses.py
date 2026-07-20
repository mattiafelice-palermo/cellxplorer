"""Fast JSON responses for the large scientific payloads.

Analysis results are plain dicts of floats and strings, often tens of
megabytes. Returning one from an endpoint normally costs two full passes over
the structure: FastAPI walks it with ``jsonable_encoder`` looking for types
that need coercion (and finds none), then serializes it again. On a 22 MB
cached result that measured 1115 ms + 370 ms.

Returning a ``Response`` instance instead makes FastAPI hand the bytes
straight to the client, skipping ``jsonable_encoder`` entirely, and orjson
serializes the same payload in ~50 ms.
"""
from __future__ import annotations

from typing import Any

import orjson
from fastapi import Response


def fast_json(content: Any, *, status_code: int = 200) -> Response:
    """Serialize ``content`` with orjson, bypassing FastAPI's encoder.

    Only use this for payloads that are already plain JSON types. Anything
    needing Pydantic/date coercion must go through the normal return path.

    ``OPT_SERIALIZE_NUMPY`` is defensive: the engine returns Python floats
    today, but a stray numpy scalar would otherwise raise at response time
    rather than being silently coerced. Non-finite floats become ``null``,
    which is stricter than the standard library's invalid ``NaN`` literal.
    """
    return Response(
        content=orjson.dumps(content, option=orjson.OPT_SERIALIZE_NUMPY),
        media_type="application/json",
        status_code=status_code,
    )
