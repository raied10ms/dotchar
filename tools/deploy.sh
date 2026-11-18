#!/usr/bin/env bash
# Build dist/ (only what the browser needs) and deploy it to Cloudflare Workers static assets.
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... tools/deploy.sh        (or put both in .env)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (env or .env)}" "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (env or .env)}"
node cli/char.mjs list > /dev/null            # fresh library index + thumbnails
rm -rf dist && mkdir -p dist
cp -R studio runtime characters mouthlib examples docs dist/
rm -f dist/studio/server.mjs dist/characters/LICENSE.md
cat > dist/index.html <<'HTML'
<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/studio/"><title>.char studio</title><a href="/studio/">.char studio</a>
HTML
echo '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found. <a href="/studio/">Open the studio</a>' > dist/404.html
printf '/*\n  X-Robots-Tag: noindex, nofollow\n/characters/*\n  Cache-Control: public, max-age=300\n' > dist/_headers
echo "dist: $(du -sh dist | cut -f1), $(find dist -type f | wc -l | tr -d ' ') files"
${WRANGLER:-npx wrangler@4} deploy
