"""Lightweight format grouping for filenames and the import search catalog."""

from pathlib import Path

MACCOR_CHANNEL_FORMAT = ".NNN"


def extension_key(suffix: str) -> str:
    """Group physical three-digit channel suffixes; .000 denotes a procedure."""
    if len(suffix) == 4 and suffix[0] == "." and suffix[1:].isascii() and suffix[1:].isdigit() and suffix != ".000":
        return MACCOR_CHANNEL_FORMAT
    return suffix.casefold()


def source_suffix(path: str | Path) -> str:
    """Retain a Maccor channel number even when the basename is just '.042'."""
    name = Path(path)
    return name.name if extension_key(name.name) == MACCOR_CHANNEL_FORMAT else name.suffix.casefold()
