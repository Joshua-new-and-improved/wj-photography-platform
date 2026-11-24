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
<footer class="foot"><div class="foot-in">
  <span>Wiaan Jordaan Photography · Centurion</span>
  <a href="https://wjphotography.co.za" rel="noopener">wjphotography.co.za</a>
</div></footer>
</body>
</html>`;
}

export type AdminSection = "overview" | "orders" | "print" | "schools" | "catalogue" | "settings";

export interface AdminBadges { awaiting: number; toPrint: number; toDeliver: number }

/**
 * The studio console shell: a sidebar on desktop, a scrolling tab strip on a
 * phone. Every admin page renders through this so navigation, the flash
 * message and the counts that say "something needs you" are identical
 * everywhere.
 */
export function adminPage(opts: {
  title: string;
  active: AdminSection;
  badges: AdminBadges;
  body: string;
  flash?: { ok: boolean; text: string } | null;
  actions?: string;
}): string {
  const item = (key: AdminSection, href: string, label: string, icon: string, badge = 0) =>
    `<a href="${href}" class="side-link${opts.active === key ? " on" : ""}"${opts.active === key ? ' aria-current="page"' : ""}>
       <span class="ico" aria-hidden="true">${icon}</span><span>${label}</span>${badge ? `<b class="badge">${badge}</b>` : ""}</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} — Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Archivo+Black&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${SHARED_CSS}${ADMIN_CSS}</style>
</head>
<body class="admin">
<aside class="side">
  <a class="side-mark" href="/admin">WIAAN JORDAAN<small>STUDIO</small></a>
  <nav class="side-nav" aria-label="Studio">
    ${item("overview", "/admin", "Overview", "◐")}
    ${item("orders", "/admin/orders", "Orders", "▤", opts.badges.awaiting)}
    ${item("print", "/admin/print", "Print &amp; deliver", "▣", opts.badges.toPrint + opts.badges.toDeliver)}
    ${item("schools", "/admin/schools", "Schools", "▦")}
    ${item("catalogue", "/admin/catalogue", "Products &amp; packages", "◇")}
    ${item("settings", "/admin/settings", "Settings", "⚙")}
    <a href="/import.html" class="side-link side-cta"><span class="ico" aria-hidden="true">＋</span><span>Import photos</span></a>
  </nav>
</aside>
<script>document.addEventListener('DOMContentLoaded',function(){var a=document.querySelector('.side-link.on');if(a&&a.scrollIntoView&&innerWidth<860)a.scrollIntoView({inline:'center',block:'nearest'});});</script>
<main class="console">
  <header class="console-head">
    <h1>${escapeHtml(opts.title)}</h1>
    <div class="console-actions">${opts.actions ?? ""}</div>
  </header>
  ${opts.flash ? `<div class="flash ${opts.flash.ok ? "ok" : ""}" role="status">${escapeHtml(opts.flash.text)}</div>
  <script>(function(){var u=new URL(location.href);u.searchParams.delete('saved');u.searchParams.delete('error');history.replaceState(null,'',u.pathname+u.search+u.hash);})();</script>` : ""}
  ${opts.body}
</main>
</body>
</html>`;
}

/** A coloured status chip. */
export function chip(text: string, tone: "ok" | "warn" | "info" | "muted" | "bad" = "muted"): string {
  return `<span class="chip ${tone}">${escapeHtml(text)}</span>`;
}

/** Stacked-row layout for an order table: used on phones, and always for compact lists. */
const ORDER_ROWS_CSS = (t: string) => `
${t} thead{display:none}
${t},${t} tbody{display:block}
${t} tr{display:grid;grid-template-columns:1fr auto;gap:4px 10px;padding:12px 14px;border-bottom:1px solid #EEECE7}
${t} tr:last-child{border-bottom:0}
${t} td{border:0!important;padding:0!important;background:none!important}
${t} .c-order{grid-column:1;grid-row:1}
${t} .c-total{grid-column:2;grid-row:1;text-align:right}
${t} .c-child{grid-column:1/-1;grid-row:2}
${t} .c-items{display:none}
${t} .c-pay{grid-column:1;grid-row:3}
${t} .c-prod{grid-column:2;grid-row:3;text-align:right}`;

const ADMIN_CSS = `
${ORDER_ROWS_CSS(".dtable.list")}
@media (max-width:700px){
  ${ORDER_ROWS_CSS(".dtable.cards")}
  .dtable.kids thead{display:none}
  .dtable.kids,.dtable.kids tbody{display:block}
  .dtable.kids tr{display:grid;grid-template-columns:1fr auto;gap:6px 10px;padding:12px 14px;border-bottom:1px solid #EEECE7}
  .dtable.kids td{border:0!important;padding:0!important}
  .dtable.kids .k-name{grid-column:1}.dtable.kids .k-card{grid-column:2;text-align:right}
  .dtable.kids .k-class{grid-column:1/-1}
  .dtable.kids .k-num{display:none}
  .dtable.kids .k-act{grid-column:1/-1}
  .dtable.kids .k-act .btn{width:100%}
}
.nowrap{white-space:nowrap}
.k-sm{display:none}
@media (max-width:700px){.k-sm{display:inline}}
body.admin{display:grid;grid-template-columns:232px 1fr;min-height:100vh;background:#F4F2EE}
.side{background:var(--graphite);color:#E9E7E2;position:sticky;top:0;height:100vh;padding:22px 14px;display:flex;flex-direction:column;gap:22px}
.side-mark{font-family:var(--display);font-size:16px;letter-spacing:-.03em;line-height:1.05;color:#fff;padding:0 10px}
.side-mark small{display:block;font-family:var(--mono);font-size:9px;font-weight:400;letter-spacing:.2em;color:#8f9198;margin-top:3px}
.side-nav{display:flex;flex-direction:column;gap:2px}
.side-link{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:6px;font-size:14px;color:#C9C7C2}
.side-link:hover{background:rgba(255,255,255,.06);color:#fff}
.side-link.on{background:rgba(255,255,255,.1);color:#fff;box-shadow:inset 3px 0 0 var(--chinagraph)}
.side-link .ico{width:18px;text-align:center;opacity:.8}
.side-link .badge{margin-left:auto;background:var(--chinagraph);color:#fff;font-family:var(--mono);font-size:11px;
  font-weight:600;min-width:20px;height:20px;border-radius:99px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}
.side-cta{margin-top:12px;border:1px dashed rgba(255,255,255,.25)}
.console{padding:26px clamp(16px,3vw,40px) 80px;min-width:0;max-width:1240px}
.console-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.console-head h1{font-family:var(--display);font-size:clamp(24px,3.4vw,32px);letter-spacing:-.03em;line-height:1.05}
.console-actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
@media (max-width:860px){
  body.admin{grid-template-columns:1fr}
  .side{position:sticky;top:0;z-index:30;height:auto;padding:10px 12px;gap:8px;flex-direction:row;align-items:center;overflow-x:auto}
  .side-mark{display:none}
  .side-nav{flex-direction:row;gap:4px}
  .side-link{white-space:nowrap;padding:8px 10px;font-size:13px}
  .side-link .ico{display:none}
  .side-cta{margin-top:0}
  body.admin .kpis{grid-template-columns:1fr 1fr;gap:8px}
  body.admin .kpi{padding:12px}
  body.admin .kpi .n{font-size:22px}
  body.admin .kpi .l{font-size:12px;margin-top:6px}
  body.admin .console{padding:18px 14px 60px}
  body.admin .console-head h1{font-size:24px}
  body.admin .console-actions{margin-left:0;width:100%}
  body.admin .panel{padding:14px;border-radius:10px}
  body.admin .kv{grid-template-columns:110px 1fr}
  body.admin .toolbar .btn{flex:none}
  body.admin .grouphead{flex-wrap:wrap}
  body.admin .grouphead form{margin-left:0;width:100%}
  body.admin .grouphead form .btn{width:100%}
  .dtable.olines thead{display:none}
  .dtable.olines,.dtable.olines tbody{display:block}
  .dtable.olines tr{display:grid;grid-template-columns:1fr auto;gap:8px;padding:12px 14px;border-bottom:1px solid #EEECE7}
  .dtable.olines td{border:0!important;padding:0!important}
  .dtable.olines .o-photos{grid-column:1/-1;grid-row:2}
  .prodcard .noprint .btn{width:100%}
  .chip{white-space:normal}
}
.panel{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:18px;margin-bottom:16px;box-shadow:0 1px 2px rgba(28,29,33,.04)}
.panel>h2{font-size:15px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:10px}
.panel>h2 .more{margin-left:auto;font-family:var(--mono);font-size:11px;font-weight:500;color:var(--silver)}
.panel>h2 .more:hover{color:var(--graphite)}
.panel .sub{color:var(--silver);font-size:13px;margin:-6px 0 12px}
.kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:16px}
.kpi{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:16px;display:block}
a.kpi:hover{border-color:var(--graphite)}
.kpi .n{font-family:var(--display);font-size:28px;letter-spacing:-.02em;line-height:1}
.kpi .l{font-size:12.5px;color:var(--silver);margin-top:8px}
.kpi.alert{border-color:var(--chinagraph);box-shadow:inset 0 3px 0 var(--chinagraph)}
.cols{display:grid;gap:16px;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}
@media (max-width:1180px){.cols{grid-template-columns:minmax(0,1fr)}}
.todo{list-style:none;display:flex;flex-direction:column;gap:8px}
.todo li a,.todo li>div{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;background:#F8F7F4;font-size:14px}
.todo li a:hover{background:#F0EEE9}
.todo .dot{width:8px;height:8px;border-radius:99px;background:var(--chinagraph);flex:none}
.todo .dot.ok{background:var(--green)}
.todo .go{margin-left:auto;color:var(--silver)}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:3px 9px;border-radius:99px;white-space:nowrap;
  background:#EFEDE8;color:#5D6068}
.chip::before{content:'';width:6px;height:6px;border-radius:99px;background:currentColor;opacity:.8}
.chip.ok{background:#E3F1EA;color:var(--green)}
.chip.warn{background:#FBEBD5;color:#8A5200}
.chip.info{background:#DDF1F6;color:#00657A}
.chip.bad{background:#FBE3E4;color:#A3151E}
.dtable{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid var(--rule);border-radius:10px;overflow:hidden;margin:0}
.dtable th{background:#FAF9F6;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--silver);
  font-weight:500;text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule)}
.dtable td{padding:11px 12px;border-bottom:1px solid #EEECE7;font-size:14px;vertical-align:middle}
.dtable tr:last-child td{border-bottom:0}
.dtable tr.rowlink{cursor:pointer}
.dtable tr.rowlink:hover td{background:#FAF9F6}
.dtable .num{text-align:right;font-family:var(--mono);white-space:nowrap}
.dtable .muted,.muted{color:var(--silver);font-size:12.5px}
.dtable .strong{font-weight:600}
.tablewrap{overflow-x:auto;border-radius:10px}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.seg{display:inline-flex;background:#fff;border:1px solid var(--rule);border-radius:8px;padding:3px;gap:2px;flex-wrap:wrap}
.seg a{padding:6px 12px;border-radius:6px;font-size:13px;color:#5D6068;display:inline-flex;gap:6px;align-items:center}
.seg a.on{background:var(--graphite);color:#fff}
.seg a .c{font-family:var(--mono);font-size:11px;opacity:.7}
.search{flex:1;min-width:200px;display:flex}
.search input,.toolbar select{width:100%;padding:9px 12px;border:1px solid var(--rule);border-radius:8px;background:#fff;font:inherit;font-size:14px}
.toolbar select{width:auto}
.btn.ghost{background:#fff;color:var(--graphite);border:1px solid var(--rule)}
.btn.ghost:hover{border-color:var(--graphite)}
.btn.green{background:var(--green)}
.btn.small{border-radius:8px}
.inline{display:inline}
.thumbs{display:flex;gap:6px;flex-wrap:wrap}
.thumb{width:62px;aspect-ratio:2/3;border-radius:5px;overflow:hidden;background:#eceae5;border:1px solid var(--rule);display:block;position:relative}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .dl{position:absolute;inset:auto 0 0 0;background:rgba(28,29,33,.75);color:#fff;font-size:10px;text-align:center;padding:2px 0}
.prodcard{border:1px solid var(--rule);border-radius:10px;padding:14px;background:#fff;margin-bottom:10px;display:grid;gap:10px;
  grid-template-columns:minmax(180px,240px) 1fr auto;align-items:start}
@media (max-width:760px){.prodcard{grid-template-columns:1fr}}
.prodcard .who b{display:block;font-size:15px}
.prodcard .items{display:flex;flex-direction:column;gap:10px}
.prodcard .item{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
.prodcard .item .thumbs{flex:1;min-width:140px}
.prodcard .item .what{min-width:150px;font-size:14px}
.prodcard .item .what small{display:block;color:var(--silver);font-size:12px}
.grouphead{display:flex;align-items:center;gap:10px;margin:22px 0 10px;font-weight:700}
.grouphead .muted{font-weight:400}
.grouphead form{margin-left:auto}
.kv{display:grid;grid-template-columns:140px 1fr;gap:8px 14px;font-size:14px}
.kv dt{color:var(--silver)}
.form-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));align-items:end}
.form-grid label{display:flex;flex-direction:column;gap:5px;font-size:13px;color:#5D6068}
.form-grid input,.form-grid select{padding:9px 11px;border:1px solid var(--rule);border-radius:8px;font:inherit;font-size:15px;background:#fff;color:var(--graphite)}
.schoolcards{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.schoolcard{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:16px;display:block}
.schoolcard:hover{border-color:var(--graphite)}
.schoolcard h3{font-size:17px;margin-bottom:10px}
.schoolcard .bar{height:6px;border-radius:99px;background:#EFEDE8;overflow:hidden;margin:8px 0 4px}
.schoolcard .bar i{display:block;height:100%;background:var(--green)}
.schoolcard .facts{display:flex;gap:14px;font-size:13px;color:#5D6068;flex-wrap:wrap}
.empty-state{text-align:center;padding:42px 20px;color:var(--silver)}
.empty-state b{display:block;color:var(--graphite);font-size:16px;margin-bottom:6px}
body.admin .flash{margin:0 0 16px;border-radius:8px}
body.admin table.edit{border-radius:10px;overflow:hidden;border-collapse:separate;border-spacing:0}
body.admin .pkgcard{border-radius:10px;padding:0;overflow:hidden}
body.admin .pkgcard>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:1fr auto auto;gap:4px 12px;align-items:center;padding:14px 16px}
body.admin .pkgcard>summary::-webkit-details-marker{display:none}
body.admin .pkgcard>summary:hover{background:#FAF9F6}
.pk-name{font-weight:700;font-size:16px}
.pk-price{font-family:var(--mono);font-weight:600}
.pk-contents{grid-column:1/-1;font-size:13px;color:#5D6068}
.pk-edit{grid-column:1/-1;font-size:12.5px;color:var(--silver);text-decoration:underline}
body.admin .pkgcard[open]>summary .pk-edit{display:none}
body.admin .pkgcard>form{padding:4px 16px 16px;border-top:1px solid #EEECE7}
.warn-text{color:#8A5200}
.pkgitem.on span{font-weight:600}
@media (max-width:700px){
  .pkgform{grid-template-columns:1fr}
  .pkgitems{grid-template-columns:1fr 1fr}
  .pkgitem input{width:48px}
  .dtable.prods thead{display:none}
  .dtable.prods,.dtable.prods tbody{display:block}
  .dtable.prods tr{display:grid;grid-template-columns:1fr auto auto;gap:8px;padding:12px;border-bottom:1px solid #EEECE7;align-items:center}
  .dtable.prods td{border:0!important;padding:0!important}
  .dtable.prods .pr-name{grid-column:1/-1}
  .dtable.prods .pr-kind{grid-column:1/-1}
  .addrow>*{flex:1 1 100%}
}
.cardsheet{margin-top:10px}
.sheethead{font-size:15px;margin:18px 0 10px;display:flex;gap:10px;align-items:baseline}
.sheethead span{font-weight:400;color:var(--silver);font-size:13px}
.cardgrid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.claimcard{background:#fff;border:1px dashed #B9B5AC;border-radius:6px;padding:16px 14px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:4px}
.cc-brand{font-family:var(--display);font-size:11px;letter-spacing:-.01em}
.cc-brand span{font-family:var(--mono);font-size:8px;letter-spacing:.18em;color:var(--silver);font-weight:400}
.cc-name{font-family:var(--display);font-size:20px;letter-spacing:-.02em;line-height:1.1;margin-top:6px}
.cc-class{font-family:var(--mono);font-size:10.5px;color:#5D6068;letter-spacing:.04em}
.cc-qr{width:118px;height:118px;margin:8px 0 4px;image-rendering:pixelated}
.cc-how{font-size:10.5px;color:#5D6068;line-height:1.35;max-width:210px}
.cc-code{font-family:var(--mono);font-size:19px;font-weight:600;letter-spacing:.08em;margin-top:2px}
@media print{
  @page{size:A4;margin:10mm}
  .console-head,.flash{display:none!important}
  .cardsheet{break-before:page}
  .cardsheet:first-of-type{break-before:auto}
  .cardgrid{grid-template-columns:repeat(3,1fr);gap:0}
  .claimcard{border-radius:0;break-inside:avoid;height:88mm;justify-content:center}
  .sheethead{margin-top:0}
  body.admin{display:block;background:#fff}
  .side,.console-actions,.toolbar,.noprint,form.inline,.grouphead form{display:none!important}
  .prodcard{break-inside:avoid;box-shadow:none}
  .console{padding:0}
}
`;

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


/* ── Shared additions ───────────────────────────────────────────── */
.money{font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.hint{color:var(--silver);font-size:13.5px;margin:-2px 0 10px;max-width:640px}
.flash{background:#fff;border:1px solid var(--rule);border-left:3px solid var(--chinagraph);
  padding:12px 14px;margin:18px 0 0;font-size:14px;border-radius:2px}
.flash.ok{border-left-color:var(--green)}
.btn.small{width:auto;padding:9px 16px;font-size:14px;margin-top:0;display:inline-block;text-align:center}
.err{color:var(--chinagraph);font-size:13px;min-height:18px}
.foot{border-top:1px solid var(--rule);margin-top:40px}
.foot-in{max-width:1180px;margin:0 auto;padding:18px 20px 28px;display:flex;gap:12px;flex-wrap:wrap;
  justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--silver);letter-spacing:.04em}
.foot-in a:hover{color:var(--graphite)}

/* ── Landing ─────────────────────────────────────────────────────── */
.how{display:grid;gap:4px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));max-width:760px;margin:10px auto 0}
.how div{background:#fff;border:1px solid var(--rule);border-radius:2px;padding:16px;text-align:left}
.how b{display:block;font-family:var(--mono);font-size:11px;color:var(--chinagraph);letter-spacing:.1em;margin-bottom:6px}
.how p{font-size:13.5px;color:var(--graphite);margin:0}
.helpline{text-align:center;color:var(--silver);font-size:13px;margin-top:26px}

/* ── Parent gallery ─────────────────────────────────────────────── */
.hero{padding:34px 0 8px}
.eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--silver)}
.hero h1{font-family:var(--display);font-size:clamp(30px,6.5vw,52px);line-height:1;letter-spacing:-.03em;margin:8px 0 14px}
.steps{list-style:none;counter-reset:s;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13.5px;color:var(--silver)}
.steps li{counter-increment:s}
.steps li::before{content:counter(s);display:inline-flex;width:20px;height:20px;border-radius:99px;
  align-items:center;justify-content:center;background:var(--graphite);color:var(--paper);
  font-family:var(--mono);font-size:11px;margin-right:7px}
.gallery{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
@media (max-width:520px){.gallery{grid-template-columns:repeat(2,1fr)}}
.gallery .frame{margin:0;border:0;background:#eceae5;border-radius:3px;overflow:hidden;position:relative}
.gallery .frame .view{display:block;width:100%;height:100%;padding:0}
.gallery .frame img{transition:transform .25s}
.gallery .frame .view:hover img{transform:scale(1.025)}
.pick{position:absolute;left:8px;right:8px;bottom:8px;display:flex;align-items:center;justify-content:center;gap:6px;
  background:rgba(251,250,247,.94);border:1px solid var(--rule);border-radius:99px;padding:7px 10px;
  font-size:13px;font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.pick .tick{display:none}
.frame.picked{outline:3px solid var(--chinagraph);outline-offset:-3px}
.frame.picked .pick{background:var(--chinagraph);border-color:var(--chinagraph);color:#fff}
.frame.picked .pick .tick{display:inline}
.orders{display:grid;gap:4px}
.orderlink{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--rule);border-radius:2px;padding:12px 14px}
.orderlink .money{margin-left:auto}
.pkgs{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.pkg{position:relative;display:grid;grid-template-columns:1fr auto;gap:4px 10px;background:#fff;border:1px solid var(--rule);
  border-radius:4px;padding:16px 16px 16px 44px;cursor:pointer;transition:border-color .15s}
.pkg input{position:absolute;left:16px;top:19px;width:18px;height:18px;accent-color:var(--chinagraph)}
.pkg:has(input:checked){border-color:var(--chinagraph);box-shadow:0 0 0 1px var(--chinagraph)}
.pkgname{font-family:var(--display);font-size:19px;letter-spacing:-.02em}
.pkgprice{font-family:var(--mono);font-size:17px;font-weight:600}
.pkgdesc{grid-column:1/-1;font-size:13.5px;color:var(--silver);line-height:1.45}
.opts{background:#fff;border:1px solid var(--rule);border-radius:4px;padding:4px 16px}
.optgroup{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--silver);padding:14px 0 4px}
.opt{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--rule);cursor:pointer}
.opt:last-child{border-bottom:0}
.opt input{width:18px;height:18px;accent-color:var(--chinagraph);flex:none}
.optname{display:flex;flex-direction:column;font-size:15px}
.optname small{font-size:12px;color:var(--silver)}
.opt .money{margin-left:auto}
.summary{background:#fff;border:1px solid var(--rule);border-radius:4px;padding:16px;max-width:560px}
.lines .line{display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:14.5px}
.totalrow{display:flex;justify-content:space-between;border-top:2px solid var(--graphite);margin-top:8px;padding-top:10px;
  font-weight:700;font-size:18px}
.field{display:block;font-size:13px;color:var(--silver);margin-top:16px}
.field input{display:block;width:100%;margin-top:6px;padding:12px;border:1px solid var(--rule);border-radius:2px;
  font-size:16px;color:var(--graphite);background:#fff}
.field input:focus{outline:none;border-color:var(--graphite);box-shadow:0 0 0 3px rgba(0,163,196,.16)}
.lines .line small.kind{display:block;font-family:var(--mono);font-size:10.5px;color:var(--silver);letter-spacing:.04em}
.status{font-size:15px;margin-bottom:10px;padding:10px 12px;background:#f6f5f1;border-radius:2px}
.status.ok{background:#f0f7f4;color:var(--green)}
.fine{font-size:12px;color:var(--silver);margin-top:12px;line-height:1.55}
.confirm{margin-top:14px;padding:14px;background:#f0f7f4;border-radius:2px}
.basket{position:fixed;left:12px;right:12px;bottom:12px;z-index:50;max-width:560px;margin:0 auto;display:flex;align-items:center;
  gap:14px;background:var(--graphite);color:var(--paper);border-radius:99px;padding:8px 8px 8px 20px;
  box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:14px}
.basket[hidden],.confirm[hidden]{display:none}
.basket .money{margin-left:auto;font-weight:600}
.basket .btn{background:var(--paper);color:var(--graphite);border-radius:99px}
.lightbox{border:0;padding:0;background:transparent;max-width:min(92vw,720px);max-height:94vh;margin:auto}
.lightbox::backdrop{background:rgba(20,20,22,.88)}
.lightbox img{display:block;max-width:100%;max-height:calc(94vh - 64px);margin:0 auto;border-radius:3px}
.lbbar{display:flex;align-items:center;justify-content:center;gap:10px;padding-top:10px}
.lbbar>button:not(.btn){color:#fff;font-size:22px;width:44px;height:44px;border-radius:99px;background:rgba(255,255,255,.12)}
.lbbar .btn{background:var(--paper);color:var(--graphite)}
.lbbar .btn.on{background:var(--chinagraph);color:#fff}
.lbclose{position:fixed;top:14px;right:14px}

/* ── Admin ──────────────────────────────────────────────────────── */
.tablewrap{overflow-x:auto}
table.edit td{vertical-align:middle}
table.edit input:not([type=checkbox]){width:100%;min-width:140px;padding:7px 8px;border:1px solid var(--rule);border-radius:2px;background:#fff}
table.edit tr.off td{opacity:.55}
.sku{font-family:var(--mono);font-size:10px;color:var(--silver);margin-top:3px;letter-spacing:.04em}
.rands{display:inline-flex;align-items:center;border:1px solid var(--rule);border-radius:2px;background:#fff;overflow:hidden}
.rands>span{font-family:var(--mono);font-size:13px;color:var(--silver);padding:0 4px 0 9px}
.rands input{border:0!important;min-width:0!important;width:96px!important;padding:8px 8px 8px 2px!important;
  font-family:var(--mono);outline:none}
.addrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center}
.addrow>input,.addrow>select{padding:9px;border:1px solid var(--rule);border-radius:2px;background:#fff;font:inherit}
.addrow>input{flex:1;min-width:200px}
.pkgcard{background:#fff;border:1px solid var(--rule);border-radius:4px;padding:16px;margin-bottom:10px}
.pkgcard.off{background:#f6f5f1}
.pkgform{display:grid;gap:10px;grid-template-columns:1fr auto}
.pkgform label{display:flex;flex-direction:column;gap:4px;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--silver)}
.pkgform label.wide{grid-column:1/-1}
.pkgform>label>input{padding:9px;border:1px solid var(--rule);border-radius:2px;font-family:var(--body);font-size:15px;
  letter-spacing:0;text-transform:none;color:var(--graphite)}
.pkglabel{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--silver);margin:14px 0 6px}
.pkglabel span{text-transform:none;letter-spacing:0}
.pkgitems{display:grid;gap:4px 14px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.pkgitem{display:flex;align-items:center;gap:8px;font-size:14px}
.pkgitem input{width:56px;padding:6px;border:1px solid var(--rule);border-radius:2px;font-family:var(--mono);text-align:center}
.pkgfoot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;flex-wrap:wrap}
.toggle{display:flex;align-items:center;gap:8px;font-size:14px}
.toggle input{width:18px;height:18px;accent-color:var(--green)}
.newpkg summary{list-style:none;cursor:pointer}
.newpkg summary::-webkit-details-marker{display:none}
.newpkg[open] summary{margin-bottom:10px}
.newpkg form{background:#fff;border:1px dashed var(--rule);border-radius:4px;padding:16px}
.newpkg form .btn{grid-column:1/-1;justify-self:start}
`;
