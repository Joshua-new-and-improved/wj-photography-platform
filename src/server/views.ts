/**
 * Server-rendered pages, using the "Contact Sheet" direction from
 * architecture §18. Kept as template strings deliberately: this is a website
 * that has to run tomorrow morning, and a template-string renderer needs
 * nothing installed beyond what is already in package.json. React/Next.js is
 * the right call for the long-term build (§17) and is not worth the setup
 * risk for tonight.
 */

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function page(opts: { title: string; nav?: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Archivo+Black&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${SHARED_CSS}</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <a class="mark" href="/">WIAAN JORDAAN<small>PHOTOGRAPHY</small></a>
    <div class="spacer"></div>
    ${opts.nav ?? ""}
  </div>
</header>
<main class="wrap">${opts.body}</main>
</body>
</html>`;
}

export const SHARED_CSS = `
:root{
  --paper:#FBFAF7;--graphite:#1C1D21;--silver:#8A8D94;--rule:#DFDCD5;
  --chinagraph:#D4212B;--register:#00A3C4;--safelight:#2B1A17;--green:#12694A;--amber:#C77700;
  --display:'Archivo Black',system-ui,sans-serif;
  --body:'Archivo',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--graphite);font-family:var(--body);
  font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
:focus-visible{outline:2px solid var(--register);outline-offset:2px}
a{color:inherit;text-decoration:none}
button,input{font:inherit;color:inherit}
button{background:none;border:none;cursor:pointer}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}

.top{position:sticky;top:0;z-index:40;background:var(--paper);border-bottom:1px solid var(--rule)}
.top-in{max-width:1180px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:16px}
.mark{font-family:var(--display);font-size:17px;letter-spacing:-.03em;line-height:1.05}
.mark small{display:block;font-family:var(--mono);font-size:9px;font-weight:400;
  letter-spacing:.17em;color:var(--silver);margin-top:2px}
.spacer{flex:1}
.navlink{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;color:var(--silver);
  padding:8px 12px;border-radius:2px}
.navlink:hover{color:var(--graphite)}

.wrap{max-width:1180px;margin:0 auto;padding:0 20px 90px}

.claim{max-width:430px;margin:0 auto;padding:64px 0 40px;text-align:center}
.claim h1{font-family:var(--display);font-size:clamp(28px,7vw,40px);line-height:.98;
  letter-spacing:-.025em;margin-bottom:12px}
.claim p{color:var(--silver);font-size:14.5px;margin-bottom:26px}
.codebox{display:flex;gap:8px;justify-content:center;margin-bottom:10px}
.codebox input{font-family:var(--mono);font-size:20px;font-weight:500;text-align:center;
  border:1px solid var(--rule);background:#fff;border-radius:2px;padding:13px 0;
  letter-spacing:.12em;text-transform:uppercase;width:100%}
.codebox input:focus{border-color:var(--graphite);outline:none;box-shadow:0 0 0 3px rgba(0,163,196,.16)}
.g4{flex:0 0 110px}.g3{flex:0 0 88px}
.btn{background:var(--graphite);color:var(--paper);width:100%;padding:14px;border-radius:2px;
  font-weight:600;font-size:15px;margin-top:10px}
.btn:disabled{opacity:.35;cursor:not-allowed}
.err{color:var(--chinagraph);font-size:13px;margin-top:12px;min-height:18px;line-height:1.5}

.sheet-head{padding:30px 0 20px;border-bottom:1px solid var(--rule);margin-bottom:4px}
.kid h1{font-family:var(--display);font-size:clamp(26px,5.5vw,38px);letter-spacing:-.025em}
.kid .cls{font-family:var(--mono);font-size:12px;color:var(--silver);letter-spacing:.08em;
  text-transform:uppercase;margin-top:6px;display:block}

.sectlabel{font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--silver);padding:26px 0 12px;display:flex;align-items:center;gap:12px}
.sectlabel::after{content:'';flex:1;height:1px;background:var(--rule)}
.sheet{display:grid;gap:4px;grid-template-columns:repeat(auto-fill,minmax(148px,1fr))}
.frame{position:relative;display:block;width:100%;aspect-ratio:2/3;background:#eceae5;
  overflow:hidden;border:1px solid var(--rule)}
.frame img{width:100%;height:100%;object-fit:cover;display:block}

table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--rule);margin-top:14px}
th{font-family:var(--mono);font-size:10px;letter-spacing:.13em;text-transform:uppercase;
  color:var(--silver);text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule);font-weight:500}
td{padding:10px 12px;border-bottom:1px solid var(--rule);font-size:13.5px}
tr:last-child td{border-bottom:0}
.pill{font-family:var(--mono);font-size:10px;letter-spacing:.07em;text-transform:uppercase;
  border:1px solid var(--rule);padding:2px 7px;border-radius:2px;color:var(--silver)}
.pill.ok{border-color:var(--green);color:var(--green)}

.card{background:#fff;border:1px solid var(--rule);border-radius:2px;padding:16px;margin-bottom:4px}
.card h3{font-family:var(--display);font-size:17px;letter-spacing:-.02em;margin-bottom:4px}
.card .meta{font-family:var(--mono);font-size:11px;color:var(--silver)}
.stats{display:grid;gap:4px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:14px 0}
.stat{background:#fff;border:1px solid var(--rule);padding:14px;border-radius:2px}
.stat .n{font-family:var(--mono);font-size:25px;font-weight:500;line-height:1}
.stat .l{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--silver);margin-top:6px}

.empty{color:var(--silver);font-size:14px;padding:40px 0;text-align:center}
.note{font-family:var(--mono);font-size:11px;color:var(--silver);line-height:1.7;
  margin-top:30px;padding-top:16px;border-top:1px solid var(--rule)}
`;
