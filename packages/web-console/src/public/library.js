// SPDX-License-Identifier: Apache-2.0
const element = (tag, text, cls) => { const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node; };
const titles={prompt:'Translation instructions',persona:'Locale personas',glossary:'Glossary'};
const singular={prompt:'instructions',persona:'persona',glossary:'term'};
const voiceFields={audience:'Audience',tone:'Tone and voice',formality:'Formality',regionalConventions:'Regional conventions',examples:'Examples to follow',avoid:'Wording and styles to avoid'};
const descriptions={prompt:'Project-wide guidance for consistent translations.',persona:'Voice, audience and cultural choices for each target language.',glossary:'Preferred translations and names that should stay unchanged.'};
export function mountLibrary({root,kind,projectSlug,request,confirmation,controllerId,draft}) {
  if(!document.querySelector('link[data-library-style]')){const link=element('link');link.rel='stylesheet';link.href='/library.css';link.dataset.libraryStyle='';document.head.append(link);}
  root.replaceChildren();root.classList.add('library-workbench');root.dataset.libraryKind=kind;root.dataset.projectSlug=projectSlug;delete root.dataset.libraryDirty;
  const header=element('header',null,'library-heading');header.append(element('h1',titles[kind]),element('p',descriptions[kind]+' Saving changes affects future AI translation revisions; existing translations stay as they are.'));
  const projectLabel=element('p',projectSlug,'library-project');header.append(projectLabel);
  const search=element('form',null,'library-search');const searchLabel=element('label','Search this section');const searchInput=element('input');searchInput.type='search';searchInput.maxLength=200;searchLabel.append(searchInput);const searchButton=element('button','Search');searchButton.type='submit';search.append(searchLabel,searchButton);
  const create=element('button','Create '+singular[kind],'primary');create.type='button';create.dataset.libraryAction='create';
  const message=element('p',null,'library-status');message.setAttribute('role','status');
  const error=element('p',null,'agent-error');error.setAttribute('role','alert');
  const editor=element('div',null,'library-editor'),list=element('div',null,'library-assets'),more=element('button','Load more');more.type='button';
  const reviews=element('details',null,'library-reviews');reviews.append(element('summary','Suggestions awaiting review'));const reviewList=element('div');const reviewMore=element('button','More suggestions');reviewMore.type='button';reviews.append(reviewList,reviewMore);
  root.append(header,search,create,message,error,editor,list,more,reviews);
  let scopes=[],cursor=null,reviewCursor=null,generation=0,listGeneration=0;
  const call=async(action,input)=>(await request('/api/actions/'+action,{projectSlug,...input})).result;
  const safe=fn=>async()=>{error.textContent='';try{await fn();}catch(e){error.textContent=e.message;}};
  function fullContent(asset) {
    const block=element('div',null,'library-content');const state=asset.content;
    if(kind==='prompt')block.append(element('p',state.body));
    else if(kind==='persona'){for(const[k,v]of Object.entries(state.body)){const section=element('section');section.append(element('strong',voiceFields[k]||k),element('p',typeof v==='string'?v:JSON.stringify(v,null,2)));block.append(section);}}
    else {block.append(element('p',state.doNotTranslate?'Do not translate':`Preferred translation: ${state.translation}`),element('p',state.description));}
    return block;
  }
  async function preview(action,input,back) {
    const proposal=(await call(action,input)).proposal;
    root.dataset.libraryDirty='true';
    editor.replaceChildren(confirmation(proposal,{
      edit:async()=>{await request(`/api/agent/proposals/${proposal.id}/reject`,{});await back();},
      cancel:async()=>{await request(`/api/agent/proposals/${proposal.id}/reject`,{});editor.replaceChildren();delete root.dataset.libraryDirty;create.focus();},
      confirm:async()=>{const saved=await request(`/api/agent/proposals/${proposal.id}/confirm`,{fingerprint:proposal.fingerprint,controllerId});editor.replaceChildren();delete root.dataset.libraryDirty;
        const outcome=saved.result.library;message.textContent=outcome.status==='submitted'?'Suggestion submitted. An authorized reviewer can approve it below. Active guidance is unchanged.':outcome.status==='rejected'?'Suggestion rejected. Active guidance is unchanged.':`${outcome.label} saved${outcome.active?' and active for future revisions': ' as inactive guidance'}. Existing translations are unchanged.`;
        try{await refresh();}catch{message.textContent+=' Refresh the Library to see the saved result.';}
      },
    }));editor.querySelector('h3')?.focus();editor.scrollIntoView({block:'nearest'});
  }
  function edit(asset=null,values=null) {
    error.textContent='';const current=asset?.content||{},permissions=asset?.permissions;
    if(permissions&&!permissions.canPropose){editor.replaceChildren(fullContent(asset));return;}
    const state={...current,...values};const form=element('form',null,'library-form');const title=element('h2',asset?'Edit '+singular[kind]:'Create '+singular[kind]);title.tabIndex=-1;form.append(title);
    const fields=element('fieldset'),controls={};
    function field(name,label,value,{multiline=false,options=null,checkbox=false,required=false,max=200,readonly=false}={}) {
      const wrapper=element('label',null,checkbox?'library-checkbox':'');const text=element('span',label);const input=element(options?'select':multiline?'textarea':'input');input.name=name;input.setAttribute('aria-label',label);wrapper.dataset.field=name;
      if(options)for(const[value,label]of options)input.append(new Option(label,value));
      if(checkbox){input.type='checkbox';input.checked=value!==false;}else{input.value=value??'';input.required=required;input.maxLength=max;input.readOnly=readonly;}
      wrapper.append(checkbox?input:text,checkbox?text:input);fields.append(wrapper);controls[name]=input;return input;
    }
    const writable=scopes.filter(s=>s.canPropose);
    const locales=writable.filter(s=>s.locale!==null).map(s=>[s.locale,s.locale]);
    if(state.locale&&!locales.some(([v])=>v===state.locale))locales.push([state.locale,state.locale]);
    if(kind==='prompt') {field('key','Key',state.key,{required:true,readonly:Boolean(asset)});field('label','Label',state.label,{required:true});field('body','Translation instructions',state.body,{multiline:true,required:true,max:12000});}
    if(kind==='persona') {
      field('locale','Target language',state.locale||locales[0]?.[0],{options:locales,required:true});if(asset)controls.locale.disabled=true;
      for(const[name,label]of Object.entries(voiceFields))field(name,label,state.body?.[name],{multiline:true,max:2000});
      const legacy=Object.keys(current.body||{}).filter(k=>!Object.hasOwn(voiceFields,k));
      if(legacy.length){const detail=element('details');detail.append(element('summary','Existing additional guidance is preserved'),element('pre',JSON.stringify(Object.fromEntries(legacy.map(k=>[k,current.body[k]])),null,2)));fields.append(detail);}
    }
    if(kind==='glossary') {
      field('term','Source term',state.term,{required:true});
      field('locale','Target language',state.locale??'',{options:[...(writable.some(s=>s.locale===null)?[['','All languages — protected names']]:[]),...locales]});
      field('translation','Preferred translation',state.translation,{max:500});field('description','Definition and usage',state.description,{multiline:true,max:2000});
      field('doNotTranslate','Do not translate this term',Boolean(state.doNotTranslate),{checkbox:true});
      const dnt=()=>{controls.translation.disabled=controls.doNotTranslate.checked;controls.translation.required=!controls.doNotTranslate.checked;};controls.doNotTranslate.addEventListener('change',dnt);dnt();
    }
    field('active','Active for future AI translation revisions',state.active!==false,{checkbox:true});
    const note=element('p','Review the exact changes before saving. If you can suggest but not approve, confirmation submits them for review.','library-note');
    const submit=element('button','Review '+singular[kind],'primary');submit.type='submit';const cancel=element('button','Cancel');cancel.type='button';cancel.addEventListener('click',()=>{editor.replaceChildren();delete root.dataset.libraryDirty;create.focus();});
    const actions=element('div',null,'library-actions');actions.append(submit,cancel);form.append(fields,note,actions);
    form.addEventListener('input',()=>{root.dataset.libraryDirty='true';});
    form.addEventListener('submit',async e=>{e.preventDefault();if(submit.disabled)return;error.textContent='';submit.disabled=cancel.disabled=true;fields.disabled=true;
      const input={expectedVersion:asset?.version??state.expectedVersion??null,active:controls.active.checked};
      if(kind==='prompt')Object.assign(input,{key:controls.key.value,label:controls.label.value,body:controls.body.value});
      else if(kind==='persona')Object.assign(input,{locale:state.locale||controls.locale.value,body:Object.fromEntries(Object.keys(voiceFields).map(k=>[k,controls[k].value]))});
      else Object.assign(input,{...(asset?{id:asset.id}:state.id?{id:state.id}:{}),term:controls.term.value,locale:controls.locale.value||null,translation:controls.doNotTranslate.checked?'':controls.translation.value,description:controls.description.value,doNotTranslate:controls.doNotTranslate.checked});
      try {await preview(`library.${kind}.save`,input,()=>edit(asset,input));}catch(e){error.textContent=e.message;}finally{submit.disabled=cancel.disabled=false;fields.disabled=false;}
    });
    editor.replaceChildren(form);title.focus();editor.scrollIntoView({block:'nearest'});
  }
  async function history(asset) {
    const box=element('section',null,'library-history');box.append(element('h2','History · '+asset.label),element('p','Restoring creates a new revision after confirmation.'));
    const entries=element('div'),next=element('button','More history');next.type='button';const close=element('button','Close history');close.type='button';close.onclick=()=>editor.replaceChildren();box.append(entries,next,close);editor.replaceChildren(box);
    let after=null;async function load(){const data=await call('library.history',{kind,key:asset.key,limit:25,...(after?{cursor:after}:{})});for(const revision of data.items){const row=element('div',null,'library-history-row');row.append(element('span',new Date(revision.createdAt).toLocaleString()+' · '+(revision.active?'active':'inactive')));if(revision.canRestore)for(const snapshot of ['after',...(revision.hasBefore?['before']:[])]){const button=element('button',snapshot==='after'?'Review restore':'Restore earlier content');button.type='button';button.onclick=safe(()=>preview('library.restore',{revisionId:revision.id,snapshot,expectedVersion:asset.version},()=>history(asset)));row.append(button);}entries.append(row);}if(!entries.childNodes.length)entries.append(element('p','No Library revisions yet. History begins with your next confirmed save.'));after=data.page.nextCursor;next.hidden=!after;}
    next.onclick=safe(load);await load();
  }
  async function loadMore(reset=false) {
    const own=++listGeneration;
    const page=await call('library.list',{kind,search:searchInput.value,limit:25,...(!reset&&cursor?{cursor}:{})});
    if(own!==listGeneration)return;
    scopes=page.scopes;projectLabel.textContent=page.project.name;create.hidden=!scopes.some(s=>s.canPropose);if(reset)list.replaceChildren();
    for(const asset of page.items){const card=element('article',null,'library-asset');card.dataset.assetKey=asset.key;card.append(element('h3',asset.label),element('p',`${asset.locale||'Project-wide'} · ${asset.active?'Active':'Inactive'}`));
      const button=element('button',asset.permissions.canPropose?'Edit':'View');button.type='button';button.onclick=safe(async()=>edit((await call('library.get',{kind,key:asset.key})).asset));
      const historyButton=element('button','History');historyButton.type='button';historyButton.onclick=safe(async()=>history((await call('library.get',{kind,key:asset.key})).asset));
      const actions=element('div',null,'library-actions');actions.append(button,historyButton);card.append(actions);list.append(card);
    }
    if(!list.childNodes.length)list.append(element('p','No matching '+titles[kind].toLowerCase()+' yet.','library-empty'));
    cursor=page.page.nextCursor;more.hidden=!cursor;
  }
  async function loadReviews(reset=false) {
    const page=await call('library.reviews',{kind,limit:25,...(!reset&&reviewCursor?{cursor:reviewCursor}:{})});if(reset)reviewList.replaceChildren();
    for(const suggestion of page.items){const row=element('article',null,'library-suggestion');row.append(element('h3',suggestion.label),element('p',`${suggestion.locale||'Project-wide'} · ${suggestion.mine?'Your suggestion':'Awaiting an authorized reviewer'}`));
      if(suggestion.canReview)for(const decision of ['approve','reject']){const button=element('button',decision==='approve'?'Review approval':'Review rejection');button.type='button';button.onclick=safe(()=>preview('library.review',{suggestionId:suggestion.id,decision},()=>{editor.replaceChildren();reviews.open=true;}));row.append(button);}
      reviewList.append(row);
    }
    if(!reviewList.childNodes.length)reviewList.append(element('p','No pending suggestions.'));reviewCursor=page.page.nextCursor;reviewMore.hidden=!reviewCursor;
  }
  async function refresh(){const own=++generation;await loadMore(true);if(own===generation)await loadReviews(true);}
  search.addEventListener('submit',e=>{e.preventDefault();void safe(()=>loadMore(true))();});more.onclick=safe(()=>loadMore());reviewMore.onclick=safe(()=>loadReviews());create.onclick=()=>edit();
  async function openDraft(value) {
    let asset=null;const key=kind==='prompt'?value.key:kind==='persona'?value.locale:value.id;
    if(key)asset=(await call('library.get',{kind,key})).asset;
    edit(asset,value);root.dataset.libraryDirty='true';
  }
  const ready=refresh().then(async()=>{if(draft)await openDraft(draft);});
  return {ready,refresh,openDraft,get dirty(){return root.dataset.libraryDirty==='true';}};
}
