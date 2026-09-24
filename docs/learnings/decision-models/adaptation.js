import {adaptationSpec,adaptationExamples} from './examples.js';
import {trialMetrics} from './core.js';
import {$,setupSettings,runSpec,settings,el,download} from './ui.js';
let receipt=null,controller=null,version=0;
function stale(){version++;receipt=null;$('comparison').replaceChildren();$('raw').textContent='No current trial.';$('download').disabled=true;$('status').textContent='Inputs changed. Run a new paired trial.';}
function render(){if(!receipt)return;const table=el('table'),head=el('tr');for(const title of ['Arm','Choice','Correct?','p(expected)','Brier ↓','Gate'])head.append(el('th',title));const thead=el('thead');thead.append(head);table.append(thead);const body=el('tbody');for(const arm of receipt.arms){const a=arm.result.data.answers.category,m=trialMetrics(a,receipt.expected,Number($('threshold').value));const tr=el('tr');for(const text of [arm.label,a.choice,String(m.correct),m.expectedProbability.toFixed(3),m.brier.toFixed(3),m.gate])tr.append(el('td',text));body.append(tr);}table.append(body);const scroll=el('div',undefined,'table-scroll');scroll.append(table);$('comparison').replaceChildren(scroll);}
setupSettings(id=>id==='threshold'?render():stale());$('labelled-examples').value=adaptationExamples;
for(const id of ['trial-state','labelled-examples','expected','drift'])$(id).addEventListener('input',stale);
$('compare').onclick=async()=>{
 stale();const started=version;controller=new AbortController();$('compare').disabled=true;$('cancel').disabled=false;$('status').textContent='Running two requests sequentially. No automatic retry.';
 try{
  const base=structuredClone(adaptationSpec);base.state=$('trial-state').value;
  if(!base.state.trim())throw new Error('Enter a test item.');
  if($('drift').value==='opaque')base.questions.category.criteria={veln:'Private category veln',sova:'Private category sova',tarn:'Private category tarn',unclear:'Insufficient policy information'};
  if($('drift').value==='swapped'){const c=base.questions.category.criteria;[c.veln,c.sova]=[c.sova,c.veln];}
  const withExamples=structuredClone(base);withExamples.state=`Labelled examples (reference only):\n${$('labelled-examples').value}\n\nNew item to classify:\n${base.state}`;
  const arms=[];const expected=$('expected').value,provider=settings().provider,mode=$('drift').value;
  for(const [label,spec] of [['Without examples',base],['With examples',withExamples]]){if(controller.signal.aborted)throw new Error('Comparison cancelled.');const result=await runSpec(spec,AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]));arms.push({label,spec,result});if(version!==started)throw new Error('Inputs changed during comparison. Results discarded; run again.');}
  receipt={at:new Date().toISOString(),provider,mode,expected,arms,qualification:provider==='illustrative'?'Synthetic fixtures only; not model measurements.':'One labelled pair; not a calibration or generalization study.'};
  $('status').textContent=`${arms[0].result.source} — two arms complete. ${receipt.qualification}`;$('raw').textContent=JSON.stringify(receipt,null,2);$('download').disabled=false;render();
 }catch(e){$('status').textContent=e.message;}finally{$('compare').disabled=false;$('cancel').disabled=true;controller=null;}
};
$('cancel').onclick=()=>controller?.abort();$('download').onclick=()=>{if(receipt)download({...receipt,threshold:Number($('threshold').value)},'adaptation-trial.json');};
