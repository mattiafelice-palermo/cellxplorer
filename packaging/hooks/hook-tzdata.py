"""Collect the unchanged package for the post-build archive, not the PYZ loader."""
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

datas = collect_data_files("tzdata") + copy_metadata("tzdata")
hiddenimports = collect_submodules("tzdata")
# A PYZ copy would take precedence over zipimport at runtime. Keep all package
# modules out of PYZ; timezone_archive.py packs these .py files with their data.
module_collection_mode = "py"
