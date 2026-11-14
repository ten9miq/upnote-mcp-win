# Preparing a release

This fork uses `@ten9miq/upnote-mcp-win`, CLI `upnote-mcp-win`, repository `https://github.com/ten9miq/upnote-mcp-win` and an independent version line starting at 0.1.0. Keep the upstream MIT notice and attribution. Old versions in the changelog are upstream history, not releases of this fork.

Publication is a separate maintainer action. Nothing in setup, CI or package creation publishes to npm, pushes a tag or creates a public GitHub release. The former upstream tag-triggered npm/macOS release workflow has been replaced by manual artifact preparation for Windows.

## Source package

```powershell
bun install --frozen-lockfile
bun run check
bun run test
bun run pack
```

`dist/ten9miq-upnote-mcp-win-0.1.0.tgz` contains runtime TypeScript and the Windows PowerShell clipboard helper, the stable/manual launcher templates, PID verification helper, documentation, license and metadata. Source packages require Bun >=1.4.0; Node.js alone cannot execute `bun:sqlite` / Bun Markdown APIs. Development test files, live-profile mutation probes, caches, credentials, local configuration, DBs and backups are not distribution assets.

Inspect the archive before release (the filename follows the current package version):

```powershell
tar -tf .\dist\ten9miq-upnote-mcp-win-0.1.0.tgz
npm pack --dry-run --ignore-scripts
```

Install the local tarball into a disposable directory and check the actual stdio MCP handshake/tool inventory before publishing. This can use a missing test DB with auto-start disabled and requires no live library access. Package metadata and the MCP server share one name/version source (`package.json`). Keep the bundle manifest version in sync.

## Windows MCPB

```powershell
bun run build:mcpb
```

This Windows-only builder compiles `src/index.ts` into `mcpb-bundle/server/upnote-mcp-win.exe`, copies `note-clipboard.ps1` beside the executable, includes the MIT license, then invokes MCPB packer 2.1.2. Output is `dist/upnote-mcp-win-0.1.0-win32-x64.mcpb` on x64 (architecture comes from the build machine). The helper is external because PowerShell cannot execute a script from Bun's virtual compiled filesystem.

The manifest identifies this fork and Windows, defaults the DB/CDP fields to empty, and keeps automatic app startup disabled. An empty DB path uses the app default. An empty CDP origin leaves native tools unconfigured; users must launch UpNote with CDP and opt in via the bundle's CDP field. The everyday launcher is not installed by opening the bundle. For automatic startup use the documented source configuration instead.

Only distribute a bundle after validating the manifest/contents, compiled stdio handshake, helper lookup, and actual install/configuration in the target Windows MCP client. Local compilation and a working source server do not prove Claude Desktop accepts every optional configuration field. Do not label this as a macOS bundle.

The `Prepare Windows release artifacts` GitHub workflow is manual (`workflow_dispatch`). It runs checks/tests and uploads the tarball/bundle as workflow artifacts. It has no npm publication job and no tag-triggered release upload.

## Publishing intentionally

1. Review changes, run the checks above and complete any remaining target-client installation checks. Check the archive for private data and verify `npm whoami` / ownership of the **ten9miq npm scope**; a GitHub account name does not establish npm ownership.
2. Confirm package and manifest versions agree, update the fork changelog, commit and tag the intended revision. An `upstream` Git remote may be used for tracking bellx2; all fork release/support links must remain under ten9miq.
3. Publish only the inspected archive with `npm publish .\dist\ten9miq-upnote-mcp-win-0.1.0.tgz --access public` using authorized credentials. This is an actual public write; artifact preparation alone does not authorize it.
4. Upload the inspected Windows bundle to a release in [this repository](https://github.com/ten9miq/upnote-mcp-win/releases). Only then document registry installation with `bunx @ten9miq/upnote-mcp-win` and a verified download link. Do not reuse upstream package names or release assets.

npm scope ownership, registry publication and GitHub release availability have not been established by local preparation. Until they are, the README's source-checkout installation remains authoritative.
