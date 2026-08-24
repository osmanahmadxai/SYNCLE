# syncle.dev

Marketing site for [Syncle](https://github.com/osmanahmadxai/SYNCLE) — a static
Next.js site, deployed to Vercel.

## Develop

```bash
npm install
npm run dev        # http://localhost:3010
```

## Build

```bash
npm run build      # emits ./out — plain static files, no server runtime
npm start          # serve ./out locally to check the real output
```

## Deploy

Vercel, with **Root Directory** set to this folder if it lives inside a larger
repo. `next.config.mjs` sets `output: 'export'`, so the build produces static
files and there is nothing to keep running.

### The /install redirect

The install command on the site is:

```
curl -fsSL https://syncle.dev/install | sh -s -- up
```

`/install` must redirect to the installer in the app repo. It is a **redirect,
not a copy** — the script keeps shipping straight from `main`, so an installer
fix reaches users on merge without redeploying this site.

Add to `vercel.json`:

```json
{
  "redirects": [
    {
      "source": "/install",
      "destination": "https://raw.githubusercontent.com/osmanahmadxai/SYNCLE/main/install.sh",
      "permanent": false
    }
  ]
}
```

`permanent: false` (302) is deliberate: a 301 is cached hard by browsers and
proxies, and would make repointing `/install` painful later.

## Notes

- The palette comes from the bridge animation in the app repo's README, so the
  site and the project's existing artwork read as one thing.
- The hero is inline SVG rather than an image: a few KB, sharp at any size,
  animates without JavaScript, and honours `prefers-reduced-motion`.
- Still missing: an OG image. `metadata` declares `summary_large_image`, so
  until one exists, links preview blank on Twitter, Slack and Discord.
