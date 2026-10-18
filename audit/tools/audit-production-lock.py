#!/usr/bin/env python3
"""Audit actual Bun-locked production dependencies against npm's bulk API.
Includes installed optional/peer dependencies conservatively, not dev roots.
Does not install/re-resolve packages or access any application database.
Usage: python3 audit/tools/audit-production-lock.py > result.json
"""
import json
import pathlib
import re
import urllib.request

root = pathlib.Path(__file__).resolve().parents[2]
manifest = json.loads((root / "package.json").read_text())
# Bun text lockfiles allow trailing commas, but no executable expressions.
lock = json.loads(re.sub(r",(?=\s*[}\]])", "", (root / "bun.lock").read_text()))
packages = lock["packages"]


def resolve_dep(parent, name):
    path = parent
    while path:
        candidate = path + "/" + name
        if candidate in packages:
            return candidate
        path = path.rsplit("/", 1)[0] if "/" in path else ""
    return name if name in packages else None


pending = list(manifest["dependencies"])
seen = set()
missing = set()
while pending:
    key = pending.pop()
    if key in seen:
        continue
    seen.add(key)
    if key not in packages:
        raise RuntimeError("Missing direct dependency: " + key)
    metadata = packages[key][2]
    for kind in ("dependencies", "optionalDependencies", "peerDependencies"):
        for dependency in metadata.get(kind, {}):
            resolved = resolve_dep(key, dependency)
            if resolved:
                pending.append(resolved)
            elif kind == "dependencies":
                missing.add(key + " -> " + dependency)
if missing:
    raise RuntimeError("Unresolved production dependencies: " + ", ".join(sorted(missing)))
inventory = {}
for key in sorted(seen):
    name, version = packages[key][0].rsplit("@", 1)
    inventory.setdefault(name, set()).add(version)
inventory = {name: sorted(versions) for name, versions in sorted(inventory.items())}
request = urllib.request.Request(
    "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
    data=json.dumps(inventory).encode(),
    headers={"Content-Type": "application/json", "Accept": "application/json"},
)
with urllib.request.urlopen(request, timeout=60) as response:
    advisories = json.load(response)
print(json.dumps({"source": request.full_url, "includes": "production roots, installed optional and peer dependencies, all locked platforms", "inventory": inventory, "advisories": advisories}, indent=2))
raise SystemExit(1 if advisories else 0)
