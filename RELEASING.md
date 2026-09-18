# Releasing a beta

## First public release

Create a standalone public repository for this extension. Do not publish its parent development directory. Set `repository`, `homepage` and `bugs` in `package.json` to that repository's actual URLs before packaging the public release. Choose the intended publisher identifier before the first public release; changing it later changes the extension identity. The local prototype used `local`.

## Each release

1. Update `package.json` and the lockfile to the new version, and describe the changes in `CHANGELOG.md`.
2. Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, and the editor host tests. Compiler tests must run with TeX installed.
3. Run `npm run package`. Install the resulting VSIX in a disposable editor profile and check live yellow highlights, compiler red squiggles, settings, and macros from an included file.
4. Commit the release and wait for the repository checks to pass. Create and push a tag matching the manifest, such as `v0.5.0`.
5. The tag workflow runs checks again, uses the resulting VSIX artifact, and prepares a **draft prerelease**. Review the notes and attached package, then publish it from GitHub Releases.

The workflows use GitHub's repository token; no marketplace token is required for GitHub release assets. They do not publish to an extension marketplace. A failed check prevents the release job from running.

If a tag workflow is rerun after it has already created a draft, it will refuse to create a duplicate release. Review the existing draft and upload the verified artifact explicitly if needed.

Users installing from GitHub update by downloading the new VSIX and using **Extensions: Install from VSIX** again. Preserve the publisher and extension name across updates. Marketplace publication can be added separately.
