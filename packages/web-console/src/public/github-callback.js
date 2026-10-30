// SPDX-License-Identifier: Apache-2.0
// Load a same-origin document first so Strict session cookies are available to
// this POST. OAuth state is single-use and bound to the initiating console user.
const params=new URLSearchParams(location.search),state=params.get('state'),code=params.get('code'),error=params.get('error');
history.replaceState(null,'','/api/github/callback');
(async()=>{try{if(error)throw new Error('GitHub authorization was cancelled. Return to the console to try again.');const r=await fetch('/api/github/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state,code})});const body=await r.json();if(!r.ok)throw new Error(r.status===401?'Your console session expired. Sign in and connect GitHub again.':body.error||'GitHub connection failed.');document.getElementById('status').textContent=`Connected as ${body.login}. Returning to Hedgeling…`;location.replace('/#workspace');}catch(e){document.getElementById('status').textContent=e.message;}})();
