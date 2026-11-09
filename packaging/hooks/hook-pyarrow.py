"""Keep Arrow's runtime intact without shipping its C++/Cython SDK or fixtures.

Flight RPC, Substrait and upstream C++ tests are unused by CellXplorer. Preserve
all other native components, including Parquet/codecs, compute and filesystems.
"""
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules
from pathlib import Path
import pefile

excludedimports = ['pyarrow.flight', 'pyarrow._flight', 'pyarrow.substrait', 'pyarrow._substrait', 'pyarrow._pyarrow_cpp_tests']
hiddenimports = collect_submodules("pyarrow", filter=lambda name: "tests" not in name.split(".") and name not in excludedimports)
datas = collect_data_files("pyarrow", excludes=[
    "include/**", "includes/**", "src/**", "tests/**",
    "**/*.lib", "**/*.h", "**/*.hpp", "**/*.cc", "**/*.cmake",
    "**/*.pxd", "**/*.pxi", "**/*.pyx", "**/*.pyi", "**/py.typed",
    "arrow_flight.dll", "arrow_python_flight.dll", "arrow_substrait.dll",
])
binaries = collect_dynamic_libs("pyarrow")
omitted = {'arrow_flight.dll', 'arrow_python_flight.dll', 'arrow_substrait.dll'}
# Fail closed if a retained library gains an eager or delayed native dependency.
import pyarrow
for native in Path(pyarrow.__file__).parent.iterdir():
    if native.suffix.lower() not in {'.dll', '.pyd'}:
        continue
    if native.name.lower() in omitted or native.name.startswith(('_flight.', '_substrait.', '_pyarrow_cpp_tests.')):
        continue
    with pefile.PE(str(native)) as pe:
        dependencies = {entry.dll.decode('ascii').lower() for key in ('DIRECTORY_ENTRY_IMPORT', 'DIRECTORY_ENTRY_DELAY_IMPORT') for entry in getattr(pe, key, [])}
    if dependencies & omitted:
        raise RuntimeError(f'Retained Arrow module {native.name} needs {dependencies & omitted}')
binaries = [(source, destination) for source, destination in binaries if Path(source).name.lower() not in omitted]
