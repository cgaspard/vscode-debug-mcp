# Release Notes

Each release has a YAML file in this directory named `<version>.yaml` (e.g. `0.1.0.yaml`, not `v0.1.0.yaml`).

The release GitHub Action reads this file when the matching `v<version>` tag is pushed and renders it into the release body and CHANGELOG.

## Schema

```yaml
version: 0.1.0            # must match package.json and the git tag (without the leading v)
date: 2026-05-24          # YYYY-MM-DD
highlights:               # 1–3 bullets shown at the top of the release body
  - Short summary of what matters most this release.
added:                    # new features
  - Streamable HTTP MCP server with 28 tools.
changed:                  # behavior/UX changes that aren't bug fixes
  - []                    # use [] for empty sections
fixed:                    # bug fixes
  - Terminal capture now records command output body between OSC 633 ;C and ;D markers.
removed:                  # removed/deprecated features
  - []
```

All four arrays are optional but recommended. Empty sections are dropped from the rendered output.

## Conventions

- One file per release, named with the bare version: `0.2.0.yaml`
- Write user-facing language ("Terminal capture now records …"), not commit messages
- Group related items into one bullet rather than one bullet per commit
- Keep `highlights` to ≤3 items
