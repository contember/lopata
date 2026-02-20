---
description: Prepare and publish a new release
allowed-tools: Bash(git:*), Bash(bun run build:assets), Read, Edit
---

## Release Process

1. **Find the last release tag and show changes since then:**

!git describe --tags --abbrev=0

!git log $(git describe --tags --abbrev=0)..HEAD --oneline

2. **Analyze the changes above and determine the version bump type:**
   - **MAJOR** (x.0.0): Breaking changes, incompatible API changes
   - **MINOR** (0.x.0): New features, functionality additions (backwards compatible)
   - **PATCH** (0.0.x): Bug fixes, small improvements, refactoring

3. **Read current version from package.json** and calculate the new version.

4. **Update version in package.json**.

5. **Run `bun run build:assets`** to verify the build succeeds.

6. **Commit, push, and create the tag:**
   ```
   git add package.json
   git commit -m "chore: bump version to <new-version>"
   git push
   git tag v<new-version>
   git push origin v<new-version>
   ```

7. **Report success** with link to GitHub Actions where the release is running.

## Notes

- CI pipeline (`.github/workflows/release.yml`) triggers on `v*` tags
- Runs lint, format check, type check, and tests before publishing
- `prepublishOnly` hook builds dashboard and error-page assets into `dist/`
- Publishes to npm with `--provenance --access public`
