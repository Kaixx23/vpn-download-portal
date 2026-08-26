# How to put this online (from nothing)

You have the code. You need two things to make it reachable:
1. **A server** that runs the code (a "host").
2. **A web address** (a "domain") so people can type it in.

Below are three paths, cheapest first. **Read "The one rule" at the bottom first — it decides everything.**

---

## The one rule (why most free hosts won't work here)

This portal's whole trick is the **mirror**: when a customer clicks Download, the file is
streamed *through your server* so the customer never touches GitHub (which is blocked in China).

For that to help, your server must be **both**:
- able to reach GitHub (to fetch the installer), **and**
- reachable by your customers in China.

Free hosts like `*.onrender.com` / `*.vercel.app` are **frequently blocked in China**, and their
free tiers cap bandwidth. So a free PaaS is a fine place to *test*, but a poor place to *serve
customers in China*. For real use you want a server on a network your customers can already reach.

> **You already run a VPN.** You already have servers your customers can reach — that's how the
> VPN works, and you have `sp-vpn-cn.onrender.com` serving subscriptions. The cheapest correct
> move is to put this download page on a server you **already** have. Start with Path A.

---

## Path A — Put it on a server you already have (free, recommended)

If you have any Linux server (a VPN node, your subscription box, anything you SSH into):

```bash
# 1. Get the code onto the server. If it's in a git repo:
git clone <your-repo-url> vpn-download-portal
cd vpn-download-portal
#    ...or just copy the folder up with scp:
#    scp -r vpn-download-portal user@your-server:~/

# 2. Node 18+ is the only requirement. Check:
node -v          # need v18 or newer

# 3. Build the catalog ONCE (this needs GitHub access — do it on the server, or
#    on any machine with internet and copy static/catalog.json across).
npm run build:catalog

# 4. Run it. MODE=mirror is what makes the China trick work.
MODE=mirror PORT=3000 node server.js
```

Test it from your own machine: open `http://your-server-ip:3000`. You should see the download page.

**Keep it running after you close the terminal** — pick one:

```bash
# Option 1: pm2 (simplest)
npm i -g pm2
pm2 start server.js --name vpn-portal --env production
pm2 save && pm2 startup     # follow the one command it prints, so it survives reboots

# Option 2: systemd (no extra software)
sudo tee /etc/systemd/system/vpn-portal.service >/dev/null <<'EOF'
[Unit]
Description=VPN download portal
After=network.target
[Service]
WorkingDirectory=/root/vpn-download-portal
Environment=MODE=mirror
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now vpn-portal
```

Now it's up on port 3000. To give it a normal web address (https://…) see **"Add a domain + HTTPS"** below.

---

## Path B — Buy a cheap VPS + a domain (the clean setup, ~$5/mo)

If you don't have a spare server:

1. **Rent a VPS.** Hetzner, Contabo, Vultr, DigitalOcean — a $4–6/mo Ubuntu 22.04 box with
   1 TB+ of transfer is plenty. Pick a location **close to your customers** (e.g. Singapore,
   Japan, or US-West) for speed.
2. **Buy a domain.** Any registrar (Namecheap, Porkbun, Cloudflare). ~$10/year. A `.com` is fine.
3. **Point the domain at the VPS.** In your registrar's DNS, add an **A record** for
   `dl.yourdomain.com` → your VPS's IP address.
4. **SSH in and follow Path A** to get it running on port 3000.
5. **Add HTTPS** (below) so it's `https://dl.yourdomain.com`.

---

## Path C — Free PaaS, just to see it live today (weak for China)

To get *something* online in 5 minutes for testing (not for real customers):

- **Render**: create a free Web Service from the repo. Build `npm install && npm run build:catalog`,
  start `node server.js`, set env `MODE=redirect`. You get a `*.onrender.com` URL.
  ⚠️ `MODE=redirect` sends the customer to GitHub to download — fine for testing, **does not**
  bypass the block. Free tier also sleeps when idle.

This is a demo, not a deployment. Move to Path A or B for real use.

---

## Add a domain + HTTPS (Caddy — automatic, one file)

Once the portal runs on port 3000 and your domain points at the server, put **Caddy** in front.
It gets and renews the HTTPS certificate for you automatically.

```bash
# install Caddy (Ubuntu/Debian)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Then edit `/etc/caddy/Caddyfile` — replace the example domain with yours:

```
dl.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

That's it — `https://dl.yourdomain.com` now serves the portal with a valid certificate.
(The repo's `Caddyfile` is a fancier version with 3 backup domains and long download timeouts;
use it once you have more than one domain.)

---

## Backup domains (the thing that saves you later)

The moment customers start sharing your link, **it will eventually get blocked.** The fix is to
have 2–3 domains pointing at the same server, listed at the bottom of the page. When one dies,
the page shows the customer which ones still work.

1. Buy 2 extra cheap domains.
2. Point them all at the same server (A records).
3. Add them to the `Caddyfile` site line: `dl1.x.com, dl2.y.com, dl3.z.org {`
4. List them in `static/index.html` under `CFG.fallbacks`.
5. Rebuild/redeploy.

Give customers **one** link. The others are the escape hatches.

---

## Before you send it to a single customer

- [ ] Open the page **from a network in China** (or ask a customer to). This is the only test
      that matters, and **I could not run it** — my sandbox is outside China. No domain choice
      here is guaranteed to work through the GFW; you must verify.
- [ ] Click a Download button and confirm a real installer arrives (not an error page).
- [ ] Set `CFG.brand` in `static/index.html` to your real name.

---

## Keeping versions fresh

Clients go stale and then nodes time out. Re-run `npm run build:catalog` occasionally (or let
`.github/workflows/refresh-catalog.yml` do it daily if the repo is on GitHub) and redeploy.
