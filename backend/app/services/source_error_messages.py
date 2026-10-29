"""Readable source-failure explanations; exception diagnostics remain unchanged."""
from __future__ import annotations

from pathlib import Path
import re

from .source_format_errors import SourceFormatError, UnsupportedSourceFormatError


def source_error_message(path: str | Path, error: SourceFormatError) -> str:
    """Explain known MPR failure evidence without asserting file corruption.

    Match reader-owned diagnostic phrases after removing the exact filename,
    so a filename containing e.g. 'truncated' cannot change classification.
    The original exception and metadata ``error`` retain the full diagnostic.
    Other adapters keep their established explanations.
    """
    reason = str(error).strip()
    if Path(path).suffix.casefold() != ".mpr":
        return reason
    filename_prefix = f"{Path(path).name} "
    if reason.startswith(filename_prefix):
        reason = reason[len(filename_prefix):]
    if isinstance(error.__cause__, OSError) or reason.startswith("Cannot open MPR source "):
        return ("CellXplorer could not open this BioLogic .mpr file. Check that the file is available "
                "and that you have read access, then retry.")
    if "is not a BioLogic MPR file" in reason:
        return "The selected .mpr file is not a BioLogic MPR container. Its contents do not match that format."
    if reason.startswith(("Cannot read BioLogic .mpr:", "Unsupported BioLogic .mpr:", "Incomplete BioLogic .mpr:")):
        return reason
    if any(text in reason for text in ("ends inside an MPR module header", "shorter than the MPR header",
                                      "truncated VMP data header", "truncated VMP column header",
                                      "truncated VMP data prefix")):
        return ("Incomplete BioLogic .mpr: the file ends before a complete block header can be read. "
                "Check that you have copied the complete original recording, then retry.")
    if "declares a truncated MPR module" in reason:
        return ("Incomplete BioLogic .mpr: a block declares more data than the file contains. "
                "CellXplorer cannot read the missing portion; try copying the complete original recording again.")
    mismatch = re.search(r"record area of (\d+) bytes is not divisible by (\d+) datapoints", reason)
    if mismatch:
        return (f"Cannot read BioLogic .mpr: the header declares {mismatch[2]} measurements, but the "
                f"{mismatch[1]} stored data bytes do not form that many complete records. "
                "The declared structure and stored data disagree.")
    technique = re.search(r"unsupported BioLogic technique discriminator (0x[0-9a-fA-F]+)", reason)
    if technique:
        return (f"Unsupported BioLogic .mpr: this recording uses a technique that CellXplorer does not "
                f"read yet (technique code {technique[1]}). Supported techniques are GCPL, CP and OCV.")
    if any(text in reason for text in ("empty VMP data block", "contains no records", "contains no MPR modules")):
        return "Cannot read BioLogic .mpr: no usable measurement records were found in the file."
    if any(text in reason for text in ("invalid MPR module marker", "trailing bytes after an MPR module",
                                      "bytes between declared MPR module boundaries", "declares module length")):
        return ("Cannot read BioLogic .mpr: the file's data-block boundaries do not match its declared "
                "structure. CellXplorer cannot reliably locate the measurements.")
    if any(text in reason for text in ("record width", "record stride", "VMP known column prefix",
                                      "opaque trailing column suffix")):
        return ("Cannot read BioLogic .mpr: the recorded measurement size does not match the declared "
                "data columns. This layout cannot be decoded reliably by the current reader.")
    if any(text in reason for text in ("VMP packed flag ID", "VMP base ID", "VMP data is missing required",
                                      "VMP column", "unknown column", "unknown VMP")):
        return ("Unsupported BioLogic .mpr: this recording uses data columns that CellXplorer cannot "
                "decode safely yet. The required measurement fields cannot be located reliably.")
    if "missing unambiguous execution markers" in reason or "Ns-change flag is ambiguous" in reason:
        return ("CellXplorer cannot separate the repeated GCPL executions: the restart markers do not "
                "match the recorded phase boundaries. Import stopped to avoid assigning incorrect cycles.")
    if "capacity transfer is ambiguous at an executed-step boundary" in reason:
        return ("CellXplorer cannot assign a capacity change to either side of a GCPL step boundary. "
                "Import stopped to avoid reporting incorrect capacity or efficiency.")
    if "BioLogic error flag set" in reason:
        return ("The instrument marked at least one measurement as an error. CellXplorer cannot use "
                "those measurements safely; inspect the recording in EC-Lab.")
    if "elapsed time decreases" in reason:
        return ("The recorded elapsed time moves backwards between measurements. CellXplorer cannot "
                "establish their order safely, so it cannot calculate cycles and capacities.")
    # Preserve a specific unrecognized reason rather than replacing it with a
    # vague diagnosis. These substitutions explain the reader's common jargon.
    reason = reason.replace("VMP Set", "protocol settings").replace("VMP data", "measurement data")
    reason = reason.replace("Ns-change", "protocol-step change").replace("Ns ", "protocol step ")
    prefix = "Unsupported" if isinstance(error, UnsupportedSourceFormatError) else "Cannot read"
    return f"{prefix} BioLogic .mpr: {reason}"
