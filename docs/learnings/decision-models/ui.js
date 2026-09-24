import {decide,illustrative,gate} from './core.js';
export const $=id=>document.getElementById(id);
export function settings(){return {provider:$('provider').value,key:$('decision-key').value,model:$('model').value,endpoint:$('endpoint').value,transport:$('transport').value};}
export function setupSettings(onChange=()=>{}){
  $('transport-field').hidden=!['localhost','127.0.0.1','[::1]'].includes(location.hostname);$('transport').addEventListener('change',()=>onChange('transport'));
  const update=()=>{const p=$('provider').value;$('jev-key-field').hidden=p!=='jev';$('kev-field').hidden=p!=='kev';$('synthetic-field').hidden=p!=='illustrative';$('model').disabled=p==='illustrative';$('model').value=p==='kev'?'kev-latest':'jev-1.13.0';$('provider-note').textContent=p==='jev'?'Run sends state, questions and your key directly to api.typesafe.ai. This can incur cost. No real-provider acceptance run has been recorded here.':p==='kev'?'Run sends state and questions to your local Python server. No browser inference. Start Kev separately; allow local-network access if asked. No Jev key is sent.':'ILLUSTRATIVE: fixed synthetic numbers, not AI. Input text is ignored; first option is favoured. No network call.';onChange();};
  $('provider').addEventListener('change',update);
  for(const id of ['threshold','strength']) $(id).addEventListener('input',()=>{$(id+'-value').textContent=Number($(id).value).toFixed(2);onChange(id);});
  $('clear-keys').onclick=()=>{document.querySelectorAll('input[type=password]').forEach(i=>i.value='');$('provider-note').textContent='Keys cleared from these input fields. In-flight requests cannot be recalled; use Cancel to stop waiting.';};
  for(const id of ['model','endpoint']) $(id).addEventListener('input',()=>onChange(id));
  update();
}
export async function runSpec(spec,signal){const cfg=settings();return cfg.provider==='illustrative'?illustrative(spec,Number($('strength').value)):decide(spec,cfg,signal);}
export function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
export function renderAnswers(target,result){target.replaceChildren();for(const [id,a] of Object.entries(result.data.answers)){
 const box=el('section',undefined,'answer');box.append(el('h3',id),el('p',a.type==='choice'?`Selected: ${a.choice}`:a.type==='score'?`Expected level: ${a.score.toFixed(2)}`:`p(yes): ${a.noul.toFixed(3)}`));
 const ps=a.type==='noul'?{yes:a.noul,no:1-a.noul}:a.probabilities;
 for(const [label,value] of Object.entries(ps)){const row=el('div',undefined,'bar'),meter=el('meter');meter.min=0;meter.max=1;meter.value=value;meter.setAttribute('aria-label',label+' probability');row.append(el('span',label),meter,el('output',(value*100).toFixed(1)+'%'));box.append(row);}
 if(a.type!=='noul')box.append(el('p',`Returned confidence: ${a.confidence.toFixed(3)} (not the winning probability)`));
 box.append(el('p',`Gate: ${gate(a,Number($('threshold').value))}`, 'gate'));target.append(box);
}}
export function download(data,name){const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=el('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
