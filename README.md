# AnimePahe Nuvio provider

This repository contains a ready-to-install Nuvio provider for AnimePahe:

```text
https://raw.githubusercontent.com/<owner>/<repository>/main
```

Add the repository URL in **Nuvio → Settings → Plugins**, then enable
**AnimePahe**.

## What it supports

- Nuvio movie and TV IDs through the `getStreams` contract
- Metadata lookup through Cinemeta
- AnimePahe title search and episode-session lookup
- Multi-season episode offset calculation when Cinemeta exposes the season list
- HLS/MP4 links exposed by AnimePahe's listed playback hosts
- AnimePahe domain selection through the provider settings screen

## Robot verification limitation

AnimePahe can serve a Cloudflare/robot security challenge on some domains and
networks. A Nuvio provider runs as a background HTTP fetcher and cannot
complete a browser challenge. This provider detects challenge responses, logs
a clear message, and returns no streams instead of trying to evade or
automate the verification. The provider defaults to the currently reachable
`animepahe.by` source, which uses a newer page format than the legacy domains.

If one of the configured domains opens normally in a regular browser, select
that domain in the AnimePahe settings. If every domain shows a challenge, use
another enabled Nuvio provider or wait until AnimePahe removes the challenge.

## Files

- `providers/animepahe.js` — the Nuvio-compatible provider module
- `manifest.json` — the repository manifest