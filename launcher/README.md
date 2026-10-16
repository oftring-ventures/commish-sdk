# commish

Runs the Commish developer CLI from the matching `@commish/sdk` release.

```sh
npx -y commish@latest
npx -y commish@latest setup --plan --json
```

Each `commish` version depends on the same exact `@commish/sdk` version, so
`commish@0.4.0` runs the `@commish/sdk@0.4.0` CLI with the same commands, output
and exit codes. This package adds no APIs: install `@commish/sdk` in your
application for the server, browser and webhook interfaces.

Setup guide: https://commish.sh/docs.md
