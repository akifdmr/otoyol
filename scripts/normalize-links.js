const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const localePattern = /^(en|tr|el|ro|sr|ru|de)(?:\/|$)/;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(fullPath);
    }
  }
  return files;
}

function localeFromFile(filePath) {
  const relative = path.relative(rootDir, filePath).replaceAll(path.sep, "/");
  const match = relative.match(localePattern);
  return match ? `/${match[1]}` : "";
}

function localLogin(filePath) {
  const locale = localeFromFile(filePath);
  return `${locale}/account/login`;
}

function normalizeAbsoluteUrl(rawUrl, filePath) {
  let parsed;
  const url = rawUrl.replaceAll("&amp;", "&");

  try {
    parsed = new URL(url);
  } catch {
    return rawUrl;
  }

  if (parsed.hostname === "register.vinetki.bg") {
    return "/_external/register/";
  }

  if (parsed.hostname === "accounts.itsbulgaria.com") {
    return localLogin(filePath);
  }

  if (parsed.hostname === "vinetki.bg") {
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  }

  if (parsed.hostname === "tollpass.bg") {
    return `/_external/tollpass${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  return rawUrl;
}

function rewriteHtml(content, filePath) {
  let next = content;

  next = next.replace(/\b(href|data-redirect|action)=["'](https?:\/\/[^"']+)["']/gi, (full, attr, rawUrl) => {
    const normalized = normalizeAbsoluteUrl(rawUrl, filePath);
    return `${attr}="${normalized}"`;
  });

  next = next.replace(/\b(href|data-redirect)=["'](?:\/|\.\.\/)?register\.html["']/gi, (full, attr) => {
    return `${attr}="/_external/register/"`;
  });

  next = next.replace(/\b(href|data-redirect)=["'](?:\/|(?:\.\.\/)+)?(?:[a-z]{2}\/)?account\/login\.html([^"']*)["']/gi, (full, attr, suffix) => {
    return `${attr}="${localLogin(filePath)}${suffix || ""}"`;
  });

  next = next.replace(/\s+target=["']_blank["']/gi, "");
  next = next.replace(/\s+rel=["']noopener["']/gi, "");
  next = next.replace(
    /data-cookie-string="([^"]*)"/gi,
    (full, cookieString) =>
      `data-cookie-string="${cookieString
        .replace(/;\s*domain=vinetki\.bg/gi, "")
        .replace(/;\s*secure/gi, "")
        .replace(/;\s*samesite=none/gi, "; samesite=lax")}"`
  );

  if (next.includes('id="cookieConsent"') && !next.includes("local-cookie-consent-fix")) {
    next = next.replace(
      /<\/body>/i,
      `    <script data-local-cookie-consent-fix>
        (function () {
            function hasConsentCookie() {
                return document.cookie.split(';').some(function (cookie) {
                    return cookie.trim().indexOf('.AspNet.Consent=') === 0;
                });
            }

            function hideCookieConsent() {
                var panel = document.getElementById('cookieConsent');
                if (panel) {
                    panel.style.display = 'none';
                }
            }

            function bindCookieConsent() {
                if (hasConsentCookie()) {
                    hideCookieConsent();
                }

                var button = document.querySelector('[data-cookie-string]');
                if (!button || button.getAttribute('data-local-cookie-bound') === 'true') {
                    return;
                }

                button.setAttribute('data-local-cookie-bound', 'true');
                button.addEventListener('click', function () {
                    document.cookie = button.getAttribute('data-cookie-string');
                    hideCookieConsent();
                });
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', bindCookieConsent);
            } else {
                bindCookieConsent();
            }
        })();
    </script>
</body>`
    );
  }

  return next;
}

let changed = 0;

for (const filePath of walk(rootDir)) {
  const before = fs.readFileSync(filePath, "utf8");
  const after = rewriteHtml(before, filePath);
  if (before !== after) {
    fs.writeFileSync(filePath, after);
    changed += 1;
  }
}

console.log(`Normalized ${changed} HTML files.`);
