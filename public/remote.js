// Remote URLs to web links and labels. Used by the page and by src/, so no DOM or Node APIs here.

/** Remote URL (https, ssh:// or user@host:path) to https://host/path, the repo page on most hosts. Null for anything else. */
export function webUrlFromRemote(url) {
  const m = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/) // a port here is the web server's, so it stays
    ?? url.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/) // a port here is ssh's, so it goes
    ?? url.match(/^[\w.-]+@([\w.-]+):(?!\/)(.+?)(?:\.git)?$/);
  return m ? `https://${m[1]}/${m[2]}` : null;
}

/** Short name for a remote: org/repo on GitHub, host/path elsewhere, the URL itself if it can't be read. */
export function remoteLabel(url) {
  const web = webUrlFromRemote(url);
  return web ? web.replace(/^https:\/\/(github\.com\/)?/, '') : url;
}

/** Name of the site a web URL points to, for link text: GitHub for github.com, else the host. */
export function siteName(webUrl) {
  const host = webUrl.match(/^https?:\/\/([^/]+)/)?.[1] ?? webUrl;
  return host === 'github.com' ? 'GitHub' : host;
}
