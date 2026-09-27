# Dependency patches

pnpm applies these on install. The root `package.json` lists them under
`pnpm.patchedDependencies`, and each app's Dockerfile copies this folder in
before `pnpm install`.

## `next@15.5.26.patch`

Google Fonts sometimes answers `next/font/google` with extensionless
`https://fonts.gstatic.com/l/font?kit=…` URLs. Next's loader reads the file
extension from the URL, so `next build` crashes with
`TypeError: Cannot read properties of null (reading '1')` in `loader.js`. This
made CI and the Docker builds of `consumer` and `partners` flaky.

The patch backports the upstream fix,
[vercel/next.js#99132](https://github.com/vercel/next.js/pull/99132), which fixes
[#99114](https://github.com/vercel/next.js/issues/99114). The loader now falls
back to the CSS `format('…')` hint, then to `woff2`.

**When upgrading Next:** the patch is pinned to 15.5.26, so pnpm refuses to
install another version while this entry exists. If the new version includes
#99132, delete the patch and its `patchedDependencies` entry. Otherwise
re-create it for the new version with `pnpm patch next@<version>` and
`pnpm patch-commit`.
