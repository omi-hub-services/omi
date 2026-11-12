import { createHash } from "node:crypto";

/**
 * The one watch page (OMI-092): framework-owned, drawn from the shared `WatchSnapshot` and used by
 * the repo's `/omi-watch` too. Approved design: docs/design/watch (mockup v5, spec.md).
 * Security (OMI-067): hashed CSP with no inline style attribute, external text only through
 * `textContent` / `setAttribute` on SVG, enumerated values only as class names, no control endpoint.
 */
const style = `
:root{--bg:#f3f5fa;--surface:#ffffff;--ink:#182334;--muted:#485970;--line:#78879b;--work:#164da1;--rework:#8d3b09;--waiting:#755000;--blocked:#a21b35;--architect:#6332a0;--ask:#8b276e;--done:#16613b;--failed:#98132c;--unknown:#485970;--workTint:#eaf2ff;--reworkTint:#fff1e7;--waitingTint:#fff6da;--blockedTint:#ffedf0;--architectTint:#f3edff;--askTint:#fcebf6;--doneTint:#e8f6ee;--failedTint:#fce7ec;--unknownTint:#edf1f5}
@media(prefers-color-scheme:dark){:root{--bg:#101722;--surface:#192332;--ink:#edf2fa;--muted:#b7c5d8;--line:#8392a7;--work:#9dc5ff;--rework:#ffc294;--waiting:#f6d17b;--blocked:#ffacba;--architect:#cbb0ff;--ask:#f2a9dc;--done:#86ddb1;--failed:#ff9db3;--unknown:#b7c5d8;--workTint:#182d49;--reworkTint:#3b291b;--waitingTint:#382f17;--blockedTint:#3c2028;--architectTint:#302344;--askTint:#38213a;--doneTint:#18382b;--failedTint:#3b1e2c;--unknownTint:#283344}}
:root{color-scheme:light dark}*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.page-header,main,.page-footer{max-width:1920px;margin:auto;padding:10px 24px}
.page-header{display:flex;align-items:baseline;gap:8px 20px;flex-wrap:wrap}
h1{font-size:24px;margin:0;letter-spacing:-.04em}h2{font-size:16px;margin:0}
h3{font-size:15px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.live{color:var(--done)}.live.stale{color:var(--waiting)}
.totals{display:flex;gap:4px 16px;margin-left:auto}.totals span{white-space:nowrap}
.notice{flex-basis:100%;font-size:12px;color:var(--muted);margin:0}.notice.warn{color:var(--waiting);font-weight:650}
main{padding-top:0}
.quota-panel{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin-bottom:10px}
.section-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}
.meta{color:var(--muted);font-size:12px}.quota-scroll{overflow-x:auto}
.quota-row{display:grid;grid-template-columns:70px minmax(160px,240px) minmax(100px,1fr) 85px 85px 115px;align-items:center;gap:12px;min-height:25px;min-width:710px;font-size:13px;font-variant-numeric:tabular-nums}
.quota-row+.quota-row{border-top:1px solid var(--line)}.quota-tool{font-weight:750}
.quota-bar{display:block;width:100%;height:10px;border:1px solid var(--line);border-radius:4px;background:var(--unknownTint)}
.quota-bar rect{fill:var(--done)}.quota-bar.low rect{fill:var(--waiting)}.quota-bar.critical rect{fill:var(--failed)}
.quota-bar.unknown{background:repeating-linear-gradient(135deg,var(--unknownTint),var(--unknownTint) 5px,var(--line) 5px,var(--line) 7px)}
.empty{padding:12px;color:var(--muted)}
.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}
.card{--state:var(--work);--tint:var(--workTint);background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--state);border-radius:6px;min-width:0}
.card.rework{--state:var(--rework);--tint:var(--reworkTint)}.card.waiting{--state:var(--waiting);--tint:var(--waitingTint)}.card.blocked{--state:var(--blocked);--tint:var(--blockedTint)}.card.architect{--state:var(--architect);--tint:var(--architectTint)}.card.ask{--state:var(--ask);--tint:var(--askTint)}
.card-header{display:flex;align-items:baseline;gap:8px;padding:6px 10px;background:var(--tint);border-bottom:1px solid var(--line)}
.key{flex:none;font-weight:800;font-size:12px;color:var(--state)}
.card-body{padding:4px 8px 0}.flow{display:block;width:100%;height:auto}
.flow text{font:15px system-ui;fill:var(--ink);text-anchor:middle;dominant-baseline:middle}
.flow .edge{fill:none;stroke:var(--muted);stroke-width:1.5;vector-effect:non-scaling-stroke}
.flow .return{stroke:var(--rework);stroke-width:2}.flow .return.history{stroke-dasharray:4 3}
.flow .branch{stroke:var(--architect);stroke-dasharray:4 3}.flow .ask-edge{stroke:var(--ask)}
.flow .arrow{fill:var(--muted)}.flow .arrow.return-head{fill:var(--rework)}.flow .arrow.branch-head{fill:var(--architect)}.flow .arrow.ask-head{fill:var(--ask)}
.node{--node:var(--unknown);--fill:var(--surface)}
.node rect,.node polygon{fill:var(--fill);stroke:var(--node);stroke-width:1.5;vector-effect:non-scaling-stroke}
.node text{fill:var(--node)}
.node.done{--node:var(--done);--fill:var(--doneTint)}
.node.current{--node:var(--work);--fill:var(--workTint)}.node.current rect,.node.current polygon,.node[aria-current] rect{stroke-width:2.5}
.node.failed{--node:var(--failed);--fill:var(--failedTint)}
.node.waiting-po{--node:var(--waiting);--fill:var(--waitingTint)}.node.waiting-po rect,.node.waiting-po polygon{stroke-dasharray:4 2}
.node.blocked{--node:var(--blocked);--fill:var(--blockedTint)}.node.blocked rect,.node.blocked polygon{stroke-dasharray:2 2}
.node.skipped{--node:var(--unknown);--fill:var(--unknownTint)}.node.skipped rect,.node.skipped polygon{stroke-dasharray:6 3}
.node.escalation{--node:var(--architect);--fill:var(--architectTint)}.node.ask{--node:var(--ask);--fill:var(--askTint)}
.flow .loop-label{fill:var(--rework);font-weight:750}.flow .template-label{fill:var(--muted);font-size:12px;text-anchor:start}
.flow .gate-label{font-size:12px}.flow .loop-plate{fill:var(--surface);stroke:var(--line);stroke-width:1}
.card-footer{padding:4px 10px;border-top:1px solid var(--line);font-size:12px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.context-toggle{padding:0 10px;border-top:1px solid var(--line);background:var(--workTint);border-radius:0 0 5px 5px}
.context-toggle summary{font-size:12px;color:var(--work);font-weight:650;cursor:pointer;min-height:24px;padding:4px 0}
.context-toggle h4{font-size:12px;margin:4px 0;color:var(--ink)}
.context-toggle p{margin:4px 0 8px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.context-toggle .missing{color:var(--failed)}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.chip{font-size:12px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:2px 6px;overflow-wrap:anywhere}
.page-footer{padding-top:0;color:var(--muted);font-size:12px;display:flex;gap:4px 12px;flex-wrap:wrap}
.legend{display:flex;gap:4px 12px;flex-wrap:wrap}
.legend .done{color:var(--done)}.legend .current{color:var(--work)}.legend .failed{color:var(--failed)}.legend .waiting{color:var(--waiting)}.legend .blocked{color:var(--blocked)}.legend .rework{color:var(--rework)}.legend .architect{color:var(--architect)}.legend .ask{color:var(--ask)}
.page-footer p{margin:0}
:focus-visible{outline:3px solid var(--work);outline-offset:3px}
.skip{position:absolute;top:8px;left:8px;transform:translateY(-200%);background:var(--surface);color:var(--ink);padding:12px;z-index:1}.skip:focus{transform:none}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media(max-width:1359px){.board{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:749px){.quota-row{min-width:0;grid-template-columns:70px 1fr 1fr;row-gap:2px;padding:4px 0}.quota-row>:nth-child(2){grid-column:span 2}.quota-row>:nth-child(3){grid-column:1/-1}}
@media(max-width:699px){.card-body{overflow-x:auto}.flow{width:auto;max-width:none}}
@media(max-width:899px){h3{white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.context-toggle summary{display:flex;align-items:center;padding:0}.board{grid-template-columns:minmax(0,1fr)}.page-header,main,.page-footer{padding-left:12px;padding-right:12px}.totals{margin-left:0;flex-wrap:wrap}.context-toggle summary{min-height:44px;font-size:14px}.card-footer{font-size:14px}.quota-row{font-size:14px}.chip,.context-toggle p,.context-toggle h4{font-size:14px}.notice,.meta{font-size:14px}.flow text{font-size:16px}}
@media(prefers-reduced-motion:reduce){*{animation:none;transition:none;scroll-behavior:auto}}
`;

/*
 * Browser script. No template literals and no markup strings: every external string goes through
 * `textContent`, and only values from the fixed lists below ever become a class name.
 */
const script = `(function(){
var doc=document;
function byId(id){return doc.getElementById(id);}
var tasksEl=byId('tasks'),quotaEl=byId('quota'),quotaMeta=byId('quota-meta'),connection=byId('connection'),totals=byId('totals'),notice=byId('notice');
var SVGNS='http://www.w3.org/2000/svg';
var TONES=['work','rework','waiting','blocked','architect','ask'];
var NODE_CLASSES=['done','current','pending','failed','waiting-po','blocked','skipped','escalation','ask'];
var SEVERITIES=['ok','low','critical','unknown'];
var EDGES=['forward','return','branch','ask'];
var HEADS={forward:'',return:' return-head',branch:' branch-head',ask:' ask-head'};
var openKeys={};
var focusKeys=new WeakMap();
var last=null;
function pick(list,value,fallback){return list.indexOf(value)>=0?value:fallback;}
function num(value){return typeof value==='number'&&isFinite(value)?value:0;}
function text(value,fallback){return typeof value==='string'&&value!==''?value:fallback;}
function list(value){return Array.isArray(value)?value.filter(function(item){return typeof item==='string';}):[];}
function add(parent,tag,content,cls){
 var node=doc.createElement(tag);
 if(content!==undefined&&content!==null)node.textContent=content;
 if(cls)node.setAttribute('class',cls);
 parent.appendChild(node);return node;
}
function shape(parent,tag,attrs,content){
 var node=doc.createElementNS(SVGNS,tag);
 Object.keys(attrs).forEach(function(key){node.setAttribute(key,String(attrs[key]));});
 if(content!==undefined)node.textContent=content;
 parent.appendChild(node);return node;
}
function caption(parent,item,cls){
 if(!item||typeof item.text!=='string'||item.text==='')return;
 var attrs={x:num(item.x),y:num(item.y),textLength:num(item.textLength),lengthAdjust:'spacingAndGlyphs'};
 if(cls)attrs['class']=cls;
 if(item.anchor==='start')attrs['text-anchor']='start';
 shape(parent,'text',attrs,item.text);
}
function points(items){return (Array.isArray(items)?items:[]).map(function(p){return num(p[0])+','+num(p[1]);}).join(' ');}
function drawFlow(parent,layout){
 if(!layout||!Array.isArray(layout.nodes)||layout.nodes.length===0){add(parent,'p','Template unavailable','empty');return;}
 var svg=shape(parent,'svg',{'class':'flow',width:num(layout.width),height:num(layout.height),viewBox:'0 0 '+num(layout.width)+' '+num(layout.height),role:'img','aria-label':text(layout.description,'Workflow diagram')});
 caption(svg,layout.template,'template-label');
 (layout.connectors||[]).forEach(function(c){
  var kind=pick(EDGES,c.kind,'forward');
  var d=(Array.isArray(c.points)?c.points:[]).map(function(p,i){return (i===0?'M ':'L ')+num(p[0])+' '+num(p[1]);}).join(' ');
  shape(svg,'path',{'class':'edge '+(kind==='ask'?'ask-edge':kind)+(c.prior===true?' history':''),d:d});
  if(Array.isArray(c.arrow))shape(svg,'polygon',{'class':'arrow'+HEADS[kind],points:points(c.arrow)});
 });
 layout.nodes.forEach(function(n){
  var g=shape(svg,'g',{'class':'node '+pick(NODE_CLASSES,n.cls,'pending')});
  if(n.current===true)g.setAttribute('aria-current','step');
  var s=n.shape||{};
  var x=num(s.x),y=num(s.y),w=num(s.w),h=num(s.h);
  if(s.kind==='diamond')shape(g,'polygon',{points:(x+w/2)+','+y+' '+(x+w)+','+(y+h/2)+' '+(x+w/2)+','+(y+h)+' '+x+','+(y+h/2)});
  else shape(g,'rect',{x:x,y:y,width:w,height:h,rx:5});
  caption(g,n.text,'');
  caption(g,n.caption,'gate-label');
 });
 (layout.plates||[]).forEach(function(p){
  var b=p.box||{};
  shape(svg,'rect',{'class':'loop-plate',x:num(b.x),y:num(b.y),width:num(b.w),height:num(b.h),rx:3});
  caption(svg,p.label,'loop-label');
 });
}
function duration(seconds){
 if(typeof seconds!=='number'||!isFinite(seconds))return 'unknown';
 var s=Math.max(0,Math.floor(seconds));
 if(s>=3600)return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
 return Math.floor(s/60)+'m '+(s%60)+'s';
}
function holdText(task,tone){
 if(tone==='ask')return 'Ask PO';
 var hold=task.hold;
 if(hold&&hold.kind==='waiting-po')return 'Waiting PO';
 if(hold&&hold.kind==='blocked'){
  var by=Array.isArray(hold.by)?hold.by.filter(function(n){return typeof n==='number';}):[];
  return by.length===0?'Blocked':'Blocked by #'+by[0]+(by.length>1?' +'+(by.length-1):'');
 }
 return null;
}
function footerText(task,tone){
 var who=task.who;
 if(!who){var held=holdText(task,tone);return held===null?'no worker':'no worker \\u00b7 '+held;}
 return [text(who.role,'unknown'),text(who.step,'unknown'),text(who.executor,'unknown')+'/'+text(who.profileId,'unknown'),text(who.model,'unknown')+'/'+text(who.effort,'unknown'),duration(who.elapsedSeconds)].join(' \\u00b7 ');
}
function chips(parent,items,mark,empty){
 var box=add(parent,'div',null,'chips');
 if(items.length===0)add(box,'span',empty,'chip');
 items.forEach(function(item){add(box,'span',mark(item),'chip');});
}
function drawContext(card,task,key,title){
 var details=add(card,'details',null,'context-toggle');
 details.setAttribute('data-panel','context');
 var summary=add(details,'summary','Skills & rules');
 focusKeys.set(summary,key);
 if(openKeys[key]===true)details.setAttribute('open','');
 details.addEventListener('toggle',function(){openKeys[key]=details.open===true||details.getAttribute('open')!==null;});
 add(details,'p',title,'full-title');
 var loaded=task.who?task.loaded:null;
 var extra=task.skillCheck&&Array.isArray(task.skillCheck.extra)?task.skillCheck.extra.map(function(e){return e&&e.name;}):[];
 var none='No running worker \\u00b7 loaded set unavailable';
 add(details,'h4','Skills');
 chips(details,loaded?list(loaded.skills):[],function(name){return extra.indexOf(name)>=0?'! Extra \\u00b7 '+name:name;},none);
 var missing=task.who&&task.skillCheck?list(task.skillCheck.missing):[];
 if(missing.length>0)add(details,'p','\\u00d7 Expected skill missing: '+missing.join(', '),'missing');
 add(details,'h4','Rules');
 var mandatory=loaded&&Array.isArray(loaded.mandatoryRules)?loaded.mandatoryRules:null;
 chips(details,loaded?list(loaded.rules):[],function(name){return mandatory===null?name:(mandatory.indexOf(name)>=0?'\\u25c6 ':'\\u25cb ')+name;},none);
 list(task.notes).forEach(function(note){add(details,'p',note);});
 return summary;
}
function drawTask(parent,task,index){
 var layout=task.layout||{};
 var tone=pick(TONES,layout.tone,'work');
 var key=text(task.runId,'task-'+index);
 var title=text(task.title,'Untitled task');
 var card=add(parent,'article',null,'card '+tone);
 card.setAttribute('aria-labelledby','task-'+index);
 var head=add(card,'header',null,'card-header');
 add(head,'span',text(task.planKey,'#'+num(task.issueNumber)),'key');
 var h3=add(head,'h3',title);h3.setAttribute('id','task-'+index);
 var body=add(card,'div',null,'card-body');
 body.setAttribute('tabindex','0');body.setAttribute('role','region');body.setAttribute('aria-label','Workflow diagram of '+text(task.planKey,'task '+num(task.issueNumber))+'; scroll horizontally on narrow screens');
 drawFlow(body,layout);
 add(card,'footer',footerText(task,tone),'card-footer');
 return drawContext(card,task,key,title);
}
function drawQuota(quota){
 quotaEl.replaceChildren();
 var q=quota||{state:'loading',rows:[]};
 var rows=Array.isArray(q.rows)?q.rows:[];
 if(q.state==='loading'){quotaMeta.textContent='Loading quota';}
 else if(q.state==='not-configured'){quotaMeta.textContent='Quota not configured';}
 else if(q.state==='unavailable'){quotaMeta.textContent='Quota unavailable: '+text(q.reason,'unknown');}
 else{quotaMeta.textContent=rows.length+' profiles';}
 if(rows.length===0){add(quotaEl,'p',q.state==='ok'?'No profiles':'Quota unknown','empty');return;}
 rows.forEach(function(row){
  var severity=pick(SEVERITIES,row.severity,'unknown');
  var left=typeof row.fiveHourLeft==='number'&&isFinite(row.fiveHourLeft)?Math.max(0,Math.min(100,row.fiveHourLeft)):null;
  var line=add(quotaEl,'div',null,'quota-row');
  add(line,'span',row.tool==='claude'?'Claude':row.tool==='codex'?'Codex':'Unknown','quota-tool');
  add(line,'span',text(row.profile,'unknown'));
  var bar=shape(line,'svg',{'class':'quota-bar '+(left===null?'unknown':severity),viewBox:'0 0 100 8',preserveAspectRatio:'none',role:'img','aria-label':left===null?'quota unknown':severity+' quota, '+left+' percent remaining'});
  if(left!==null)shape(bar,'rect',{x:0,y:0,width:left,height:8});
  function pct(value){return typeof value==='number'&&isFinite(value)?Math.round(value)+'%':'\\u2014';}
  add(line,'span','5h '+pct(row.fiveHourLeft));
  add(line,'span','7d '+pct(row.sevenDayLeft));
  add(line,'span','reset '+text(row.resetText,'\\u2014')+(row.freshness==='stale'?' \\u00b7 stale':''));
 });
}
function drawTotals(tasks){
 totals.replaceChildren();
 function stat(count,label){var span=add(totals,'span',null);add(span,'strong',String(count));add(span,'span',' '+label);}
 stat(tasks.length,'tasks');
 stat(tasks.filter(function(t){return t.who;}).length,'workers');
 stat(tasks.filter(function(t){return t.hold&&t.hold.kind==='waiting-po'||(t.layout&&t.layout.tone==='ask');}).length,'PO decisions');
 stat(tasks.filter(function(t){return t.hold&&t.hold.kind==='blocked';}).length,'blocked');
}
function render(snapshot){
 var focused=doc.activeElement?focusKeys.get(doc.activeElement):undefined;
 var tasks=Array.isArray(snapshot.tasks)?snapshot.tasks:[];
 drawTotals(tasks);
 drawQuota(snapshot.quota);
 tasksEl.replaceChildren();
 if(tasks.length===0)add(tasksEl,'p',snapshot.board==='loading'?'Loading tasks / quota':'No active tasks','empty');
 var summaries={};
 tasks.forEach(function(task,index){summaries[text(task.runId,'task-'+index)]=drawTask(tasksEl,task,index);});
 if(focused!==undefined&&summaries[focused]&&summaries[focused].focus)summaries[focused].focus();
 var boardNote=snapshot.board==='unavailable'?'GitHub board unavailable \\u2014 titles may be stale.':snapshot.board==='not-configured'?'GitHub board not configured \\u2014 titles unavailable.':'';
 notice.textContent=boardNote;
 notice.setAttribute('class',boardNote===''?'notice':'notice warn');
}
function live(message,stale){
 connection.textContent=message;
 connection.setAttribute('class',stale?'live stale':'live');
}
var events=new EventSource('/events');
events.onopen=function(){if(last===null)live('\\u25cf Connected \\u00b7 loading tasks / quota',false);};
events.onmessage=function(event){
 var frame;
 try{frame=JSON.parse(event.data);}catch(error){live('\\u25cf Unreadable update \\u00b7 showing last data',true);return;}
 if(frame.state!=='ok'||!frame.snapshot){live(last===null?'\\u25cf Snapshot unavailable \\u00b7 retrying':'\\u25cf Snapshot unavailable \\u00b7 read-only, last data from '+last,true);return;}
 try{render(frame.snapshot);}catch(error){live('\\u25cf Snapshot could not be displayed',true);return;}
 last=text(frame.snapshot.generatedAt,'unknown time');
 live('\\u25cf Live \\u00b7 updated '+last,false);
};
events.onerror=function(){live(last===null?'\\u25cf Disconnected \\u00b7 reconnecting':'\\u25cf Disconnected \\u00b7 reconnecting, showing data from '+last,true);};
})();`;
const hash = (value: string) => `'sha256-${createHash("sha256").update(value).digest("base64")}'`;
export const PAGE_CSP = `default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
const legend = [
  ["done", "✓ Done"],
  ["current", "▶ Current"],
  ["", "○ Pending"],
  ["failed", "× Failed"],
  ["waiting", "Ⅱ Waiting PO"],
  ["blocked", "⊘ Blocked"],
  ["", "– Skipped"],
  ["rework", "↶ Rework count"],
  ["architect", "! Architect"],
  ["ask", "? Ask PO"],
]
  .map(([cls, label]) => `<span${cls === "" ? "" : ` class="${cls ?? ""}"`}>${label ?? ""}</span>`)
  .join("");
export const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>omi watch</title><style>${style}</style></head><body><a class="skip" href="#tasks">Skip to tasks</a><header class="page-header"><h1>omi watch</h1><span id="connection" class="live" role="status">● Connecting…</span><div class="totals" id="totals" aria-label="Totals"></div><p class="notice" id="notice"></p></header><main><section class="quota-panel" aria-labelledby="quota-heading"><div class="section-top"><h2 id="quota-heading">Quota left</h2><span class="meta" id="quota-meta">Loading quota</span></div><div class="quota-scroll" id="quota" tabindex="0" role="region" aria-label="Profile quota rows; scroll horizontally on narrow screens"></div></section><h2 class="sr-only">Tasks</h2><div class="board" id="tasks"><p class="empty">Loading tasks / quota</p></div></main><footer class="page-footer"><div class="legend" aria-label="Diagram legend">${legend}</div><p>Small diamond = gate · Build = implement · D/V/R = design/verify/review · cost = approval · ev = evidence.</p><p>◆ Mandatory rule · ○ Step-only guidance · hatched quota bar = unknown. Read-only view.</p></footer><script>${script}</script></body></html>`;
