const fs = require("fs");
const http = require("http");
const path = require("path");

const rootDir = __dirname;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const upstreamOrigin = process.env.UPSTREAM_ORIGIN || "https://vinetki.bg";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const proxyGetMatchers = [
  /\/cookie-consent-text$/i,
  /\/buyvignette\/shoppingcartnumberofitems$/i,
  /\/buyvignette\/wizard$/i,
  /\/buyvignette\/checkforoverlappingvignette$/i
];

const localeSegment = "(?:en|tr|el|ro|sr|ru|de)";
const accountLoginPattern = new RegExp(`^/(?:${localeSegment}/)?account/login(?:\\.html)?/?$`, "i");
const externalAccountBrowserPattern = /^\/_external\/accounts\/(?:login|register)(?:\/)?$/i;

function safePathname(url) {
  return decodeURIComponent(url.pathname).replace(/^\/+/, "");
}

function fileForRequest(url) {
  const cleanPath = safePathname(url) || "index.html";
  const candidates = [];

  candidates.push(path.join(rootDir, cleanPath));
  if (!path.extname(cleanPath)) {
    candidates.push(path.join(rootDir, `${cleanPath}.html`));
    candidates.push(path.join(rootDir, cleanPath, "index.html"));
  }

  return candidates.find((candidate) => {
    const relative = path.relative(rootDir, candidate);
    return !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  });
}

function shouldProxy(req, url) {
  if (url.pathname.startsWith("/_external/tollpass/")) return true;
  if (url.pathname.startsWith("/_external/register/")) return true;
  if (url.pathname.startsWith("/_external/accounts/")) return true;
  if (accountLoginPattern.test(url.pathname)) return true;
  if (req.method !== "GET" && req.method !== "HEAD") return true;
  return proxyGetMatchers.some((matcher) => matcher.test(url.pathname));
}

function upstreamUrl(url) {
  if (url.pathname.startsWith("/_external/accounts/")) {
    const accountsPath = url.pathname.replace(/^\/_external\/accounts/, "") || "/";
    return `https://accounts.itsbulgaria.com${accountsPath}${url.search}`;
  }

  if (url.pathname.startsWith("/_external/register/")) {
    const registerPath = url.pathname.replace(/^\/_external\/register/, "") || "/";
    return `https://register.vinetki.bg${registerPath}${url.search}`;
  }

  if (accountLoginPattern.test(url.pathname)) {
    return `${upstreamOrigin}${url.pathname.replace(/\.html\/?$/i, "")}${url.search}`;
  }

  if (url.pathname.startsWith("/_external/tollpass/")) {
    const tollpassPath = url.pathname.replace(/^\/_external\/tollpass/, "") || "/";
    return `https://tollpass.bg${tollpassPath}${url.search}`;
  }

  return `${upstreamOrigin}${url.pathname}${url.search}`;
}

function proxyPrefixForTarget(target) {
  const hostname = new URL(target).hostname;
  if (hostname === "accounts.itsbulgaria.com") return "/_external/accounts";
  if (hostname === "register.vinetki.bg") return "/_external/register";
  if (hostname === "tollpass.bg") return "/_external/tollpass";
  return "";
}

function accountExternalRedirect(url) {
  if (!externalAccountBrowserPattern.test(url.pathname)) {
    return null;
  }

  const accountsPath = url.pathname.replace(/^\/_external\/accounts/i, "") || "/";
  return `https://accounts.itsbulgaria.com${accountsPath}${url.search}`;
}

function rewriteHtmlForProxy(target, contentType, buffer) {
  if (!contentType || !contentType.toLowerCase().includes("text/html")) {
    return buffer;
  }

  const prefix = proxyPrefixForTarget(target);
  if (!prefix) {
    return buffer;
  }

  const html = buffer.toString("utf8").replace(/\b(href|src|action)=["']\/(?!\/|_external\/)([^"']*)["']/gi, (full, attr, value) => {
    return `${attr}="${prefix}/${value}"`;
  });

  return Buffer.from(html, "utf8");
}

async function proxy(req, res, url) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const target = upstreamUrl(url);
      const headers = { ...req.headers };
      delete headers.host;
      headers.origin = new URL(target).origin;
      headers.referer = `${new URL(target).origin}/`;

      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
        redirect: "manual"
      });

      const responseHeaders = {};
      upstream.headers.forEach((value, key) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "set-cookie"].includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      const setCookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
      if (setCookies.length > 0) {
        responseHeaders["set-cookie"] = setCookies.map((cookie) =>
          cookie
            .replace(/;\s*domain=[^;]+/gi, "")
            .replace(/;\s*secure/gi, "")
            .replace(/;\s*samesite=none/gi, "; SameSite=Lax")
        );
      }

      const location = upstream.headers.get("location");
      if (location) {
        const targetPrefix = proxyPrefixForTarget(target);
        responseHeaders.location = location.startsWith("/")
          ? `${targetPrefix}${location}`
          : location
              .replace(/^https:\/\/vinetki\.bg/i, "")
              .replace(/^https:\/\/tollpass\.bg/i, "/_external/tollpass")
              .replace(/^https:\/\/register\.vinetki\.bg/i, "/_external/register")
              .replace(/^https:\/\/accounts\.itsbulgaria\.com/i, "/_external/accounts");
      }

      res.writeHead(upstream.status, responseHeaders);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.end(rewriteHtmlForProxy(target, upstream.headers.get("content-type"), buffer));
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Proxy request failed", message: error.message }));
    }
  });
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const externalAccountLocation = accountExternalRedirect(url);
    if ((req.method === "GET" || req.method === "HEAD") && externalAccountLocation) {
      res.writeHead(302, { location: externalAccountLocation });
      res.end();
      return;
    }

    if (shouldProxy(req, url)) {
      proxy(req, res, url);
      return;
    }

    const filePath = fileForRequest(url);
    if (filePath) {
      serveStatic(res, filePath);
      return;
    }

    proxy(req, res, url);
  })
  .listen(port, host, () => {
    console.log(`vinetki.bg local server: http://${host}:${port}`);
  });
