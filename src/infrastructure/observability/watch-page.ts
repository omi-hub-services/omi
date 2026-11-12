import { createHash } from "node:crypto";

const style = `
body{font:16px system-ui;background:#101820;color:#edf4f5;margin:2rem}
article{border:1px solid #48606b;padding:1rem;margin:1rem 0}
ol{display:flex;flex-wrap:wrap;gap:1.5rem;list-style:none;padding:0}
li{border:1px solid #647985;padding:.7rem}
li[data-state=done]{border-color:#77c5a0}
li[data-state=current]{border:3px solid #69bcff}
li[data-state=blocked],li[data-state=failed],li[data-state=waiting-po]{border-color:#ffb56b}
small{display:block;color:#becdd3}p{overflow-wrap:anywhere}
.flow{display:block;width:100%;max-width:1000px}
.flow rect{fill:#172530;stroke:#647985;stroke-width:2}
.flow text{fill:#edf4f5;font:12px system-ui}
.flow path{stroke:#9bafb8;stroke-width:2}
.flow path.rework{stroke:#ff9d8e}.flow path.ask-po{stroke:#ffb56b;stroke-dasharray:5 3}
.flow [data-state=done] rect{stroke:#77c5a0}
.flow [data-state=current] rect{stroke:#69bcff;stroke-width:3}
.flow [data-state=blocked] rect,.flow [data-state=waiting-po] rect,.flow [data-state=failed] rect{stroke:#ffb56b}
`;
const script = `const root=document.getElementById('tasks');
const message=document.getElementById('connection');
function add(parent,tag,text){const node=document.createElement(tag);node.textContent=text;parent.appendChild(node);return node;}
const states=new Map(['done','current','todo','blocked','waiting-po','failed'].map(state=>[state,state]));
function shape(parent,tag,attrs,text){
 const element=document.createElementNS('http://www.w3.org/2000/svg',tag);
 for(const [key,value] of Object.entries(attrs))element.setAttribute(key,String(value));
 if(text!==undefined)element.textContent=text;
 parent.appendChild(element);return element;
}
function flow(card,diagram){
 const main=diagram.nodes.filter(node=>node.kind==='step'||node.kind==='gate');
 const extra=diagram.nodes.filter(node=>node.kind==='architect'||node.kind==='ask-po');
 const rows=Math.ceil(main.length/4);
 const svg=shape(card,'svg',{viewBox:'0 0 800 '+(rows*100+180),class:'flow',role:'img','aria-label':'Workflow diagram'});
 const positions=new Map();
 main.forEach((node,index)=>positions.set(node.id,[12+(index%4)*200,15+Math.floor(index/4)*100]));
 extra.forEach((node,index)=>positions.set(node.id,[210+index*200,rows*100+45]));
 function link(a,b,kind,back){
  if(!a||!b)return;
  let d;
  if(!back&&a[1]===b[1]){
   const x=b[0],y=b[1]+27;
   d='M '+(a[0]+180)+' '+(a[1]+27)+' L '+x+' '+y+' M '+(x-6)+' '+(y-4)+' L '+x+' '+y+' L '+(x-6)+' '+(y+4);
  }else{
   const x=a[0]+90,y=a[1]+54,tx=b[0]+90,ty=b[1]+(back?54:0),bend=Math.max(y,ty)+45;
   d='M '+x+' '+y+' C '+x+' '+bend+' '+tx+' '+bend+' '+tx+' '+ty+' M '+(tx-4)+' '+(ty+6)+' L '+tx+' '+ty+' L '+(tx+4)+' '+(ty+6);
  }
  shape(svg,'path',{d,class:kind,fill:'none'});
 }
 main.forEach((node,index)=>{if(index>0)link(positions.get(main[index-1].id),positions.get(node.id),'forward',false);});
 const edge=diagram.reworkEdge;
 if(edge){
  const from=positions.get(edge.from),to=positions.get(edge.to);
  const architect=extra.find(node=>node.kind==='architect');
  const ask=extra.find(node=>node.kind==='ask-po');
  const middle=architect&&positions.get(architect.id);
  if(middle){link(from,middle,'rework',true);link(middle,to,'rework',true);}
  else link(from,to,'rework',true);
  if(ask)link(middle||from,positions.get(ask.id),'ask-po',false);
 }
 for(const node of diagram.nodes){
  const position=positions.get(node.id);if(!position)continue;
  const [x,y]=position;
  const group=shape(svg,'g',{'data-state':states.get(node.state)||'todo'});
  shape(group,'rect',{x,y,width:180,height:54,rx:6});
  shape(group,'text',{x:x+8,y:y+20},node.label);
  shape(group,'text',{x:x+8,y:y+40},node.state+' | '+node.sub);
 }
}
const events=new EventSource('/events');
events.onmessage=function(event){
 const frame=JSON.parse(event.data);
 if(frame.state!=='ok'){message.textContent='Runtime snapshot unavailable; retrying';return;}
 const snapshot=frame.snapshot;
 message.textContent='Updated '+snapshot.generatedAt+' | GitHub: '+snapshot.board;
 root.replaceChildren();
 if(!snapshot.tasks.length)add(root,'p','No active runs');
 for(const task of snapshot.tasks){
  const card=add(root,'article','');
  add(card,'h2','#'+task.issueNumber+' '+(task.planKey||'')+' '+(task.title||'Untitled task'));
  add(card,'p','Workflow: '+(task.workflow||'unavailable')+' | '+task.runStatus+(task.hold?' | '+(task.hold.kind==='waiting-po'?'Waiting PO':'Blocked'):''));
  if(task.who)add(card,'p',task.who.executor+' / '+task.who.profileId+' / '+task.who.model+' '+(task.who.effort||'')+' since '+task.who.startedAt);
  flow(card,task.diagram);
  const diagram=add(card,'ol','');diagram.setAttribute('aria-label','Workflow steps and gates');
  for(const node of task.diagram.nodes){
   const box=add(diagram,'li',node.label+' — '+node.state);box.setAttribute('data-state',states.get(node.state)||'todo');
   add(box,'small',node.kind+' | '+node.sub);
   add(box,'small','Skills: '+node.skills.join(', ')+' | Rules: '+node.rules.join(', '));
  }
  const edge=task.diagram.reworkEdge;
  if(edge)add(card,'p','↶ '+edge.from+' → '+edge.to+' | quality failures: '+edge.failures);
  add(card,'p','Rework: '+task.cycle.rework+'/'+task.cycle.of+' | '+task.cycle.phase);
  if(task.loaded)add(card,'p','Loaded skills: '+task.loaded.skills.join(', ')+' | rules: '+task.loaded.rules.join(', '));
  if(task.skillCheck)add(card,'p','Missing skills: '+task.skillCheck.missing.join(', ')+' | Extra skills: '+task.skillCheck.extra.map(item=>item.name).join(', '));
  for(const note of task.notes)add(card,'p',note);
 }
};
events.onerror=function(){message.textContent='Disconnected; reconnecting';};`;
const hash = (value: string) => `'sha256-${createHash("sha256").update(value).digest("base64")}'`;
export const PAGE_CSP = `default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
export const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>omi-squad watch</title><style>${style}</style></head><body><h1>omi-squad watch</h1><p id="connection" role="status">Connecting…</p><main id="tasks"></main><script>${script}</script></body></html>`;
