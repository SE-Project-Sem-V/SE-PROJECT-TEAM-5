const { isIP } = require("node:net");

class TransportConfigurationError extends Error {
  constructor() {
    super("Invalid transport configuration. Use loopback local development/test or the documented same-host secure proxy configuration.");
    this.name = "TransportConfigurationError";
  }
}

function address(value) {
  if (typeof value !== "string" || !isIP(value) || value.includes("%")) return null;
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // Normalize IPv4-mapped IPv6 TCP peers to their actual IPv4 address.
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function isLoopback(value) {
  const ip = address(value);
  return ip === "::1" || (isIP(ip || "") === 4 && ip.startsWith("127."));
}

function createTransportPolicy(env = process.env) {
  const mode = env.TRANSPORT_MODE || (env.NODE_ENV === "production" ? "proxy" : "local");
  const host = env.BACKEND_HOST || "127.0.0.1";
  const trusted = new Set();
  if (!isLoopback(host) || !["local", "proxy"].includes(mode)) throw new TransportConfigurationError();
  if (mode === "local") {
    if (!["development", "test"].includes(env.NODE_ENV || "development") || env.TRUSTED_PROXY_IPS) {
      throw new TransportConfigurationError();
    }
  } else {
    if (typeof env.TRUSTED_PROXY_IPS !== "string" || !env.TRUSTED_PROXY_IPS.trim()) {
      throw new TransportConfigurationError();
    }
    for (const entry of env.TRUSTED_PROXY_IPS.split(",")) {
      const ip = address(entry.trim());
      // This HTTP server supports a same-host proxy only. Remote upstreams
      // would also require TLS; accepting their plaintext assertions is unsafe.
      if (!ip || !isLoopback(ip) || trusted.has(ip)) throw new TransportConfigurationError();
      trusted.add(ip);
    }
  }

  const clientUrl = env.CLIENT_URL ?? (mode === "local" ? "http://localhost:5173" : undefined);
  let origin;
  try { origin = new URL(clientUrl); } catch { throw new TransportConfigurationError(); }
  if (!/^https?:\/\//i.test(clientUrl) || (mode === "proxy" && origin.protocol !== "https:") ||
      origin.username || origin.password || origin.pathname !== "/" ||
      origin.search || origin.hash || /[\s\\@]/u.test(clientUrl)) {
    throw new TransportConfigurationError();
  }

  function isTrustedProxy(ip) { return trusted.has(address(ip)); }

  function allows(req) {
    const peer = req.socket?.remoteAddress;
    if (mode === "local") return isLoopback(peer);
    if (!isTrustedProxy(peer)) return false;
    // Only this single proxy contract is supported. Inspect raw headers so
    // Node's header joining cannot hide duplicate or ambiguous assertions.
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (name === "forwarded") return false;
      if (name === "x-forwarded-proto") {
        if (req.rawHeaders[i + 1] !== "https") return false;
        count += 1;
      }
    }
    return count === 1;
  }

  function validateListener(value) {
    if (!isLoopback(value)) throw new TransportConfigurationError();
  }

  return Object.freeze({ mode, host, clientOrigin: origin.origin, allows, isTrustedProxy, validateListener });
}

module.exports = { createTransportPolicy, TransportConfigurationError };
