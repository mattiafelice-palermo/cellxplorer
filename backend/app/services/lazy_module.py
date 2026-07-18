"""Small thread-safe proxy for expensive optional-at-request-time modules."""
from __future__ import annotations

import threading
from types import ModuleType
from typing import Callable


class LazyModule:
    """Load a module on first attribute access, then behave like that module."""

    def __init__(self, loader: Callable[[], ModuleType]):
        self._loader = loader
        self._module: ModuleType | None = None
        self._lock = threading.Lock()

    def _load(self) -> ModuleType:
        module = self._module
        if module is not None:
            return module
        with self._lock:
            if self._module is None:
                self._module = self._loader()
            return self._module

    def __getattr__(self, name: str):
        return getattr(self._load(), name)

    def __setattr__(self, name: str, value) -> None:
        if name.startswith("_"):
            object.__setattr__(self, name, value)
            return
        setattr(self._load(), name, value)

    def __delattr__(self, name: str) -> None:
        if name.startswith("_"):
            object.__delattr__(self, name)
            return
        delattr(self._load(), name)
