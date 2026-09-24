import {validateSpec,generate,gate,requestFor} from './core.js';
import {examples} from './examples.js';
import {$,settings,setupSettings,runSpec,renderAnswers,el,download} from './ui.js';
let spec,current='tools',last=null,controller=null,generationController=null,position=[0,0],stage='new',version=0;
function invalidate(reason='Inputs changed. Run again before applying.'){version++;last=null;$('apply').disabled=true;$('download').disabled=true;$('answers').replaceChildren();$('raw').textContent='No current result.';$('status').textContent=reason;}
function world(){
 const root=$('world');root.replaceChildren();
 if(current==='game'){const grid=el('div',undefined,'grid');grid.setAttribute('aria-label',`Player row ${position[0]}, column ${position[1]}; goal row 4 column 4`);for(let r=0;r<5;r++)for(let c=0;c<5;c++)grid.append(el('div',r===position[0]&&c===position[1]?'You':r===4&&c===4?'Goal':'',`cell${r===position[0]&&c===position[1]?' player':''}${r===4&&c===4?' goal':''}`));root.append(grid);}
 if(current==='machine')root.append(el('p',`Current support state: ${stage}`));
}
function contextual(){
 if(current==='game'){
  const [r,c]=position;const criteria={};if(c<4)criteria.right=`Move right to (${r},${c+1})`;if(r<4)criteria.down=`Move down to (${r+1},${c})`;if(c>0)criteria.left=`Move left to (${r},${c-1})`;if(r>0)criteria.up=`Move up to (${r-1},${c})`;
  spec.questions.action.criteria=criteria;spec.state=`Grid 5×5. Player at row ${r}, column ${c}. Goal at row 4, column 4. Choose a legal move closer to the goal.`;
 }
 if(current==='machine'){
  spec.questions.action.criteria=stage==='new'?{triage:'Inspect evidence before any resolution',hold:'Ask a person for clarification'}:stage==='triaged'?{resolve:'Record a proposed resolution for human review',hold:'Request further evidence'}:{archive:'Archive this simulated resolved case',hold:'Reopen with a human'};
  spec.state=`Support state: ${stage}. Customer requests a refund for a damaged item. Inspect first, then propose a resolution; no actual refund is authorized.`;
 }
}
function load(name){current=name;position=[0,0];stage='new';spec=structuredClone(examples[name]);contextual();$('demo-title').textContent=spec.title;$('demo-description').textContent=spec.description;$('state').value=spec.state;$('questions').value=JSON.stringify(spec.questions,null,2);$('effect').textContent='No action applied.';world();invalidate('Ready. '+(settings().provider==='illustrative'?'ILLUSTRATIVE mode — fixed numbers, not AI.':'Real provider selected. Run sends this state.'));}
function readSpec(){let questions;try{questions=JSON.parse($('questions').value);}catch{throw new Error('Questions are not valid JSON. Fix them before running.');}return validateSpec({...spec,state:$('state').value,questions});}
function refresh(){if(!last)return;renderAnswers($('answers'),last.result);const action=last.result.data.answers.action??last.result.data.answers.route;const allowed=action?.type==='choice'&&gate(action,Number($('threshold').value))==='accept';$('apply').disabled=!allowed||!['tools','routing','machine','game','adaptive'].includes(current);}
setupSettings(id=>{if(id==='threshold')refresh();else invalidate();});
$('example').onchange=()=>{if($('example').value!=='custom')load($('example').value);};$('reset').onclick=()=>load(current==='custom'?'tools':current);
for(const id of ['state','questions'])$(id).addEventListener('input',()=>invalidate());
$('run').onclick=async()=>{
 invalidate('Running…');const started=version;controller=new AbortController();$('run').disabled=true;$('cancel').disabled=false;
 try{const submitted=readSpec(),result=await runSpec(submitted,AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]));if(version!==started){$('status').textContent='Inputs changed during request. Result discarded; run again.';return;}
  last={at:new Date().toISOString(),spec:submitted,request:requestFor(submitted,settings().provider==='illustrative'?'illustrative':settings().model),result};
  $('status').textContent=`${result.source} · ${result.data.model??result.requestedModel} · ${result.elapsed.toFixed(1)}ms wall time${settings().provider==='illustrative'?' (synthetic; not inference latency)':''}`;
  $('raw').textContent=JSON.stringify(last,null,2);$('download').disabled=false;refresh();if(current==='ranking')$('effect').textContent='Ranked by expected level (ties preserve input order): '+Object.entries(result.data.answers).sort((a,b)=>b[1].score-a[1].score).map(([id,a])=>id+' '+a.score.toFixed(2)).join(' → ');
 }catch(e){$('status').textContent=e.message;}finally{$('run').disabled=false;$('cancel').disabled=true;controller=null;}
};
$('cancel').onclick=()=>controller?.abort();$('download').onclick=()=>{if(last)download({...last,threshold:Number($('threshold').value)},'decision-run.json');};
$('apply').onclick=()=>{
 if(!last)return;const a=last.result.data.answers.action??last.result.data.answers.route;if(!a||gate(a,Number($('threshold').value))!=='accept')return;
 const choice=a.choice;let effect='';
 if(current==='tools')effect=choice==='list_tabs'?'Simulated list_tabs → “Browser APIs”, “Documentation”. No real tabs accessed.':choice==='search_notes'?'Simulated search_notes → “Offline architecture notes”. No files read.':'Abstained. No tool executed.';
 if(current==='routing')effect=`Simulated route → ${choice}. No model call or hand-off made.`;
 if(current==='adaptive') {const component=el('fieldset'),legend=el('legend','Selected next step: '+choice);component.append(legend);const label=el('label',choice==='clarify'?'What is your main goal?':choice==='upload'?'Describe the document you want to discuss':'What would you like to learn?');label.htmlFor='adaptive-answer';const input=el('textarea');input.id='adaptive-answer';component.append(label,input);$('world').replaceChildren(component);effect='A fixed, trusted component was selected. No generated HTML executed.';}
 if(current==='game'){
  if(!Object.hasOwn(spec.questions.action.criteria,choice)){$('effect').textContent='Illegal move refused by application.';return;}
  if(choice==='right')position[1]++;if(choice==='left')position[1]--;if(choice==='down')position[0]++;if(choice==='up')position[0]--;
  effect=position[0]===4&&position[1]===4?'Goal reached. Reset to play again.':`Moved ${choice}. Run the next decision when ready.`;
 }
 if(current==='machine'){
  const legal=stage==='new'?['triage','hold']:stage==='triaged'?['resolve','hold']:['archive','hold'];
  if(!legal.includes(choice)){$('effect').textContent='Illegal transition refused by application.';return;}
  if(choice==='triage')stage='triaged';else if(choice==='resolve')stage='resolved';else if(choice==='archive')stage='archived';effect=`Support state → ${stage}. Simulation only; no external action.`;
 }
 const source=last.result.source;invalidate('Choice applied locally. Run again for a new decision.');$('effect').textContent=source+' — '+effect;
 if(['game','machine'].includes(current)){contextual();$('state').value=spec.state;$('questions').value=JSON.stringify(spec.questions,null,2);world();}
};
$('generator-provider').onchange=()=>{$('generator-model').value=$('generator-provider').value==='claude'?'claude-sonnet-4-5':'gpt-4.1-mini';};
$('seed').onclick=()=>{$('specification').value=JSON.stringify(examples.moderation,null,2);$('generation-status').textContent='Checked example JSON — not generated by an API. Edit it, then validate and load.';};
$('generate').onclick=async()=>{generationController=new AbortController();$('generate').disabled=true;$('cancel-generation').disabled=false;$('generation-status').textContent='Generating a specification…';try{const result=await generate($('idea').value,{provider:$('generator-provider').value,key:$('generator-key').value,model:$('generator-model').value,transport:$('transport').value},AbortSignal.any([generationController.signal,AbortSignal.timeout(45000)]));$('specification').value=JSON.stringify(result,null,2);$('generation-status').textContent='Generated and schema-checked. Review the specification, then choose Validate & load. Nothing has run.';}catch(e){$('generation-status').textContent=e.message;}finally{$('generate').disabled=false;$('cancel-generation').disabled=true;generationController=null;}};
$('cancel-generation').onclick=()=>generationController?.abort();
$('load-spec').onclick=()=>{try{spec=validateSpec(JSON.parse($('specification').value));current='custom';if(!$('example').querySelector('[value=custom]')){const o=el('option','Custom specification');o.value='custom';$('example').append(o);}$('example').value='custom';$('demo-title').textContent=spec.title;$('demo-description').textContent=spec.description;$('state').value=spec.state;$('questions').value=JSON.stringify(spec.questions,null,2);$('world').replaceChildren();$('effect').textContent='Custom specifications can display decisions, not execute actions.';invalidate('Custom specification loaded. No API call made.');$('generation-status').textContent='Loaded safely. Use Run decision above.';}catch(e){$('generation-status').textContent='Specification refused: '+e.message;}};
const requested=new URL(location.href).searchParams.get('demo');if(requested&&Object.hasOwn(examples,requested)){$('example').value=requested;load(requested);}else load('tools');
