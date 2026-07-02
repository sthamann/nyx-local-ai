---
name: release-nyx
description: Ship a new nyx-local-ai release end to end — bump versions consistently, run the quality gates (typecheck, smoke tests, package), install locally, tag and push so CI publishes the installer artifacts. Use when the user asks to release, ship, publish, bump the version, or cut a new build of the extension.
---

# Releasing nyx-local-ai

Follow this checklist in order. Abort on the first failed step.

```
Release progress:
- [ ] 1. Bump version everywhere
- [ ] 2. Quality gates
- [ ] 3. Package + local install
- [ ] 4. Commit, tag, push
- [ ] 5. Verify CI release
```

## 1. Bump version everywhere

Three places must always carry the same version:

```bash
# package.json         → "version": "X.Y.Z"
# README.md            → status line **vX.Y.Z** and all nyx-local-ai-X.Y.Z.vsix mentions
# src/mcp/client.ts    → clientInfo: { version: 'X.Y.Z' }
```

## 2. Quality gates

```bash
npm run typecheck               # must exit 0
node .harness/smoke.mjs         # must print ALL PASS
node .harness/readme-check.mjs  # must print "README CHECK: ALL PASS"
npm run build                   # must print "[nyx] build complete"
```

The readme-check verifies all three version locations AND that every setting,
command, and tool is documented in README.md — fix any FAIL before continuing
(update the README, don't weaken the check).

If parser/edit logic changed in this release, confirm `.harness/smoke.mjs`
covers it before proceeding.

## 3. Package + local install

```bash
npm run package              # check the reported size stays ≈4–6 MB
bash install.sh --editor=cursor --vsix=./nyx-local-ai-X.Y.Z.vsix
```

Remind the user to run *Developer: Reload Window* to activate the build.

## 4. Commit, tag, push

Only commit when the user asked for it. Then:

```bash
git tag vX.Y.Z && git push origin main vX.Y.Z
```

The tag triggers `.github/workflows/release.yml`, which attaches
`nyx-local-ai.vsix` (stable name), the versioned `.vsix`, and `checksums.txt`
to the GitHub release — exactly what `install.sh`/`install.ps1` download.

## 5. Verify CI release

```bash
gh run list --repo sthamann/nyx-local-ai --limit 3
gh release view vX.Y.Z --repo sthamann/nyx-local-ai --json assets -q '.assets[].name'
```

Expected assets: `nyx-local-ai.vsix`, `nyx-local-ai-X.Y.Z.vsix`,
`checksums.txt`. If the run failed, read the log
(`gh run view <id> --log-failed`) and fix before announcing the release.
