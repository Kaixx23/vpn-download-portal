/**
 * Netlify Edge Function: /api/auth and /api/admin
 * Provides server-side One-Time Password (OTP) enforcement, device-binding anti-sharing,
 * and real-time visitor access + download logging for the Admin Board.
 */

const ADMIN_PIN = Deno.env.get("ADMIN_PIN") || "200324";
const CUSTOMER_PIN = Deno.env.get("CUSTOMER_PIN") || "200303";

// Persistent state within the Edge isolate
const STATE = globalThis.__SP_PORTAL_ADMIN_STATE__ || {
  codes: [],
  logs: [],
};
globalThis.__SP_PORTAL_ADMIN_STATE__ = STATE;

function parseDevice(ua = "") {
  if (!ua) return "Unknown Device";
  let os = "Device";
  if (/iPhone/i.test(ua)) {
    const m = ua.match(/OS (\d+[_\d]*)/);
    os = "iPhone" + (m ? " (iOS " + m[1].replace(/_/g, ".") + ")" : "");
  } else if (/iPad/i.test(ua)) {
    os = "iPad (iPadOS)";
  } else if (/Android/i.test(ua)) {
    const ver = ua.match(/Android\s+([0-9.]+)/i)?.[1] || "";
    const model = ua.match(/;\s*([^;)]+)\s+Build\//i)?.[1]?.trim() || "";
    os = `Android ${ver}${model ? " · " + model : ""}`.trim();
  } else if (/Windows NT 10\.0/i.test(ua)) {
    os = "Windows 10/11 PC";
  } else if (/Windows/i.test(ua)) {
    os = "Windows PC";
  } else if (/Mac OS X/i.test(ua)) {
    os = "macOS";
  } else if (/Linux/i.test(ua)) {
    os = "Linux";
  }
  let browser = "";
  if (/MicroMessenger/i.test(ua)) browser = "WeChat";
  else if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  return browser ? `${os} · ${browser}` : os;
}

function getClientInfo(req, context) {
  const ip =
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("cf-connecting-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
  const city = context?.geo?.city || "";
  const country = context?.geo?.country?.name || context?.geo?.country?.code || "";
  const location = [city, country].filter(Boolean).join(", ") || "Direct";
  return { ip, location };
}

function addLog(entry) {
  STATE.logs.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    ...entry,
  });
  if (STATE.logs.length > 300) STATE.logs.length = 300;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default async (request, context) => {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const { ip, location } = getClientInfo(request, context);
  const ua = request.headers.get("user-agent") || "";
  const device = parseDevice(ua);

  if (pathname === "/api/auth" && request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const pin = String(body.code || body.pin || "").trim();
    const deviceId = String(body.deviceId || "").trim();

    if (pin === ADMIN_PIN) {
      addLog({
        type: "unlock_admin",
        status: "ok",
        who: "Admin (Owner)",
        code: "Admin PIN",
        device,
        ip,
        location,
        detail: "Unlocked Portal + Admin Console",
      });
      return json({
        ok: true,
        role: "admin",
        who: "Admin (Owner)",
        label: "Admin (Owner)",
      });
    }

    if (pin === CUSTOMER_PIN) {
      addLog({
        type: "unlock_customer",
        status: "ok",
        who: "Customer (200303)",
        code: CUSTOMER_PIN,
        device,
        ip,
        location,
        detail: "Unlocked portal with permanent customer PIN",
      });
      return json({
        ok: true,
        role: "customer",
        who: "Customer (200303)",
        label: "Customer (200303)",
        code: CUSTOMER_PIN,
        uses: 0,
        maxUses: 0,
      });
    }

    const codeObj = STATE.codes.find((c) => c.code === pin);
    if (!codeObj) {
      addLog({
        type: "blocked_wrong_pin",
        status: "blocked",
        who: "Unknown Visitor",
        code: pin ? pin.slice(0, 12) : "(empty)",
        device,
        ip,
        location,
        detail: "Invalid password attempt blocked",
      });
      return json({ ok: false, error: "Incorrect password. Please try again." }, 401);
    }

    if (codeObj.revoked) {
      addLog({
        type: "blocked_revoked",
        status: "blocked",
        who: codeObj.label,
        code: codeObj.code,
        device,
        ip,
        location,
        detail: "Blocked: Code was revoked by Admin",
      });
      return json({ ok: false, error: "This access password has been revoked by the administrator." }, 403);
    }

    if (codeObj.expiresAt && Date.now() > new Date(codeObj.expiresAt).getTime()) {
      addLog({
        type: "blocked_expired",
        status: "blocked",
        who: codeObj.label,
        code: codeObj.code,
        device,
        ip,
        location,
        detail: "Blocked: Access code expired",
      });
      return json({ ok: false, error: "This access password has expired. Please request a new one." }, 403);
    }

    if (codeObj.lockDevice && codeObj.boundDeviceId && deviceId && codeObj.boundDeviceId !== deviceId) {
      addLog({
        type: "blocked_sharing",
        status: "blocked",
        who: codeObj.label,
        code: codeObj.code,
        device,
        ip,
        location,
        detail: `Anti-share triggered: Code locked to ${codeObj.boundDeviceLabel || "first device"}`,
      });
      return json(
        {
          ok: false,
          error: "Password sharing blocked: This one-time code is locked to the original device.",
        },
        403,
      );
    }

    if (codeObj.maxUses > 0 && codeObj.uses >= codeObj.maxUses) {
      addLog({
        type: "blocked_exhausted",
        status: "blocked",
        who: codeObj.label,
        code: codeObj.code,
        device,
        ip,
        location,
        detail: `Blocked reuse: Limit reached (${codeObj.uses}/${codeObj.maxUses} uses)`,
      });
      return json(
        {
          ok: false,
          error: `This one-time password has already been used (${codeObj.uses}/${codeObj.maxUses}) and is now locked.`,
        },
        403,
      );
    }

    codeObj.uses += 1;
    codeObj.lastUsedAt = new Date().toISOString();
    codeObj.lastIp = ip;
    if (deviceId && !codeObj.boundDeviceId) {
      codeObj.boundDeviceId = deviceId;
      codeObj.boundDeviceLabel = device;
    }

    addLog({
      type: "unlock_customer",
      status: "ok",
      who: codeObj.label,
      code: codeObj.code,
      device,
      ip,
      location,
      detail: `Unlocked portal (Use ${codeObj.uses} of ${codeObj.maxUses || "∞"})`,
    });

    return json({
      ok: true,
      role: "customer",
      who: codeObj.label,
      label: codeObj.label,
      code: codeObj.code,
      uses: codeObj.uses,
      maxUses: codeObj.maxUses,
      expiresAt: codeObj.expiresAt,
    });
  }

  if (pathname === "/api/auth/event" && request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch {}
    addLog({
      type: "download",
      status: "ok",
      who: String(body.who || "Visitor"),
      code: String(body.code || "-"),
      device,
      ip,
      location,
      detail: `Downloaded ${body.app || ""} (${body.file || "installer"})`.trim(),
    });
    return json({ ok: true });
  }

  if (pathname === "/api/admin") {
    const headerPin = request.headers.get("x-admin-pin") || "";
    if (headerPin !== ADMIN_PIN) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    if (request.method === "GET") {
      return json({
        ok: true,
        codes: STATE.codes,
        logs: STATE.logs,
      });
    }

    if (request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const action = body.action;

      if (action === "create_code") {
        const label = String(body.label || "Customer").trim() || "Customer";
        const rawCode = String(body.customCode || body.code || "").trim();
        const code = rawCode || String(Math.floor(100000 + Math.random() * 900000));
        const maxUses = Number(body.maxUses ?? 1);
        const expiresInMinutes = Number(body.expiresInMinutes ?? 60);
        const lockDevice = body.lockDevice !== false;

        if (code === ADMIN_PIN || STATE.codes.some((c) => c.code === code)) {
          return json({ ok: false, error: "This PIN already exists. Choose another." }, 400);
        }

        const item = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          code,
          label,
          maxUses,
          uses: 0,
          createdAt: new Date().toISOString(),
          expiresAt: expiresInMinutes > 0 ? new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString() : null,
          lockDevice,
          boundDeviceId: null,
          boundDeviceLabel: null,
          revoked: false,
        };
        STATE.codes.unshift(item);
        return json({ ok: true, item, codes: STATE.codes });
      }

      if (action === "revoke_code" || action === "toggle_revoke") {
        const target = STATE.codes.find((c) => c.id === body.id || c.code === body.code);
        if (target) target.revoked = !target.revoked;
        return json({ ok: true, codes: STATE.codes });
      }

      if (action === "delete_code") {
        const idx = STATE.codes.findIndex((c) => c.id === body.id || c.code === body.code);
        if (idx !== -1) STATE.codes.splice(idx, 1);
        return json({ ok: true, codes: STATE.codes });
      }

      if (action === "clear_logs") {
        STATE.logs.length = 0;
        return json({ ok: true, logs: STATE.logs });
      }
    }
  }

  return json({ ok: false, error: "Not found" }, 404);
};

export const config = {
  path: ["/api/auth", "/api/auth/event", "/api/admin"],
};
