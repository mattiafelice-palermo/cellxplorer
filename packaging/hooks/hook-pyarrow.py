"""Keep Arrow's runtime intact without shipping its C++/Cython SDK or fixtures.

All runtime submodules and dynamic libraries remain collected. Only development
data is excluded; no Parquet codec, filesystem or scientific runtime is removed.
"""
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

hiddenimports = collect_submodules("pyarrow", filter=lambda name: "tests" not in name.split("."))
datas = collect_data_files("pyarrow", excludes=[
    "include/**", "includes/**", "src/**", "tests/**",
    "**/*.lib", "**/*.h", "**/*.hpp", "**/*.cc", "**/*.cmake",
    "**/*.pxd", "**/*.pxi", "**/*.pyx", "**/*.pyi", "**/py.typed",
])
binaries = collect_dynamic_libs("pyarrow")
