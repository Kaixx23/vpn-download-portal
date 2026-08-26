# VPN Setup Guide (send this to your customers)

> The whole thing takes about 2 minutes. If you get stuck, see the last section.

## Step 1: Get your subscription link

Support will send you a link that looks like this:

```
https://your-domain.com/sub/yourname
```

**This link is yours alone — don't share it.** Tap to copy it, or long-press → Copy.

---

## Step 2: Install for your device

### 📱 iPhone / iPad

⚠️ **These apps are not on the China App Store**, so you need a **non-China Apple ID**
(US or HK region — free to create, choose "None" for payment).

| App | Price | Notes |
|---|---|---|
| **Shadowrocket** | US$2.99 | Top pick, easiest to use |
| **Karing** | Free | If you'd rather not pay |
| **V2Box** | Free | Simplest interface |
| Stash / Surge 5 / Quantumult X / Loon | Paid | For advanced users |

**Steps:**
1. Sign into the App Store with a non-China Apple ID, search for the app above, install it
2. Open the app → tap **`+`** or **"Add config / Subscribe"**
3. Choose **"Download from URL"**
4. Paste your link → save
5. Back on the home screen, select that profile → toggle the connect switch → the system asks "Allow adding VPN configuration?" → **Allow**

✅ Done. You'll see a VPN icon in the status bar when connected.

---

### 🤖 Android

On the download page, tap **v2rayNG** (recommended) to get the `.apk`.

1. Open the downloaded file to install. If the browser warns "unknown source app", choose **Allow install**
2. Open v2rayNG → tap the **`+`** in the top corner
3. Choose **"Import subscription / From URL"**
4. Paste your link → save
5. Back on the home screen, **tap to select** the profile you just imported
6. Tap the **connect button** (bottom right) → when the VPN prompt appears, tap **OK**

✅ Done. You'll see a key icon in the notification bar.

---

### 💻 Windows

On the download page, tap **Clash Verge Rev** to get `x64-setup.exe`.

1. Double-click to install. If Windows Defender blocks it → click **"More info" → "Run anyway"**
2. Open the app, find **"Subscriptions / Profiles"** on the left
3. Click **"New / Import"** → paste your link → OK
4. **Click to select** that subscription in the list (a lot of people skip this step)
5. Turn on **"System Proxy"** (or TUN mode)

✅ Done. Your browser can now reach the open internet.

---

### 🍎 Mac

On the download page, tap **Clash Verge Rev**. Choose `aarch64.dmg` for Apple silicon, `x64.dmg` for Intel.
(Not sure which? Click  → About This Mac, look at the "Chip" line.)

1. Open the `.dmg` and **drag the app into the Applications folder**
2. If it says **"is damaged and can't be opened"** on first launch, open Terminal, run this line, then reopen the app:
   ```
   xattr -cr /Applications/Clash\ Verge.app
   ```
3. Open the app → **"Profiles / Subscriptions"** → New → paste your link → save and select it
4. Turn on **"System Proxy"** or **"TUN mode"**

✅ Done.

---

## Step 3: Everyday use

- **After each restart**, make sure the app is running and the system proxy is on
- If it's slow, **switch to a different node** — don't keep using the same one
- Nodes update from time to time. Click **"Update subscription"** in the client to pull the latest

---

## ❓ Troubleshooting

**Can't connect / keeps timing out?**
Do this one thing first: **update the client to the latest version.** That's the cause nine times
out of ten — old versions can't recognize new nodes. The download page always has the latest,
so just download and reinstall.

**Antivirus flagged the software?**
These apps modify the system proxy, so they get false-flagged. The files are all original and
unmodified. Some files on the download page show "sha256 verified" so you can confirm nothing
was tampered with. Add an exception and install normally.

**The download page won't open?**
Try in order:
1. There are **several backup domains at the bottom of the page** — try each until one opens
2. If you saved the page before, open that saved copy
3. Contact support for a new link

**Do this now:** **bookmark** the download page and **screenshot the backup domains.**

---

**Still stuck?** Send support these three things: your device model, which app you installed, and a screenshot of the error.
