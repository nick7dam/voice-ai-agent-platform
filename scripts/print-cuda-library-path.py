import importlib.util
import os
import sys


REQUIRED_MODULES = [
    "nvidia.cublas.lib",
    "nvidia.cudnn.lib",
]

OPTIONAL_MODULES = [
    "nvidia.cuda_runtime.lib",
]


def module_path(module_name: str) -> str | None:
    try:
        spec = importlib.util.find_spec(module_name)
    except ModuleNotFoundError:
        return None

    if spec is None:
        return None

    if spec.submodule_search_locations:
        return next(iter(spec.submodule_search_locations))

    if spec.origin:
        return os.path.dirname(spec.origin)

    return None


paths: list[str] = []
missing: list[str] = []

for module_name in REQUIRED_MODULES:
    path = module_path(module_name)
    if path:
        paths.append(path)
    else:
        missing.append(module_name)

for module_name in OPTIONAL_MODULES:
    path = module_path(module_name)
    if path:
        paths.append(path)

if missing:
    print(
        "Missing CUDA Python library packages: "
        + ", ".join(missing)
        + ". Install a CUDA-enabled torch build in this environment or make "
        + "sure your system CUDA libraries are already available.",
        file=sys.stderr,
    )
    sys.exit(1)

print(":".join(dict.fromkeys(paths)))
