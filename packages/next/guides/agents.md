# Agent integration guide — Pages preview

Pages targets paired 0.3.0; first establish approved registry availability or the exact reviewed candidate artifact/version. Do not describe the published 0.2.3 release as supporting it. Read `pages.md` before changing a merchant app.

1. Inspect package manager, lockfile, Next version, app/src/app, config, auth/proxy, CMS catch-alls, current Commish integration and working-tree changes.
2. Run `commish-next pages init --dry-run --json`. Ask for missing product choices together: origin, prefix, program, consent behavior, approved content and whether short URLs are wanted. Use `--apply` only within authorized implementation scope; preserve custom files.
3. Keep credentials server-side. Never echo credentials, invent live keys, write secrets into source or expose them to a browser. Preserve TEST/LIVE and application binding.
4. Prefer `/c/[creator]`. Root aliases are optional fallback redirects after merchant routing. Never install blanket middleware, override auth/CMS, infer path ownership from a 404, or promote an unverified short URL.
5. Connect actual consent controls; default denied. Await bounded capture on the shopping path and propagate the separate measurement ID through trusted checkout. Wire `withdrawCreatorPageMeasurement` into the consent-update server handler and retry unsuccessful revocation. Browser purchases are not conversion evidence.
6. Run read-only doctor, package/build checks and a real TEST conversion/refund journey. Report installed, API-resolved, alias-verified and end-to-end-verified separately. Verify future creators work with no new merchant deploy.
7. Upgrade paired artifacts deliberately. Removal preserves ordinary referral integration, merchant files and historical financial records. Follow the Pages guide.

## Copyable AGENTS.md section

Review with the repository owner before copying; the installer never edits agent instructions.

```md
## Commish Pages

- Read the installed @commish/next/guides/pages.md and guides/agents.md. Confirm the exact Pages-capable artifact; registry 0.2.3 does not include this preview.
- Inspect first; run commish-next pages init --dry-run --json before --apply. Preserve the package manager, lockfile, current routing, authentication and user edits.
- Keep Commish secret keys server-only and out of logs/commits. Use application-scoped TEST credentials until LIVE release is explicitly authorized.
- Default to /c/[creator]. Root aliases may run only after merchant routing via fallback or an explicit CMS handoff; verify before promoting them.
- Wire real consent; keep page measurement distinct from commission attribution. Never report browser purchases as trusted conversions.
- Installed is not verified: test typed visit, capture, checkout, trusted conversion/refund, duplicates, consent withdrawal, routing conflicts and new creators without redeployment.
- Upgrade paired packages intentionally. On removal, disable Pages/aliases/tests and remove only owned integration code; preserve historical records and other referrals.
```
