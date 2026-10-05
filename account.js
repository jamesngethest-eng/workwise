let selectedRole=localStorage.getItem('workwise-role')||'freelancer';
let accountMode='signin';
const loginPage=document.getElementById('loginPage');
const employerPage=document.getElementById('employerPage');
const loginForm=document.getElementById('loginForm');
const roleOptions=[...document.querySelectorAll('.role-option')];

function setRole(role){selectedRole=role;roleOptions.forEach(button=>button.classList.toggle('active',button.dataset.role===role))}
function hideAccountViews(){document.getElementById('plansPage').hidden=true;document.getElementById('plansNav').classList.remove('active');loginPage.hidden=true;employerPage.hidden=true;document.getElementById('communityPage').hidden=true;document.querySelector('.welcome').hidden=true;document.querySelector('.search-panel').hidden=true;document.querySelector('.content-grid').hidden=true}
function showLogin(role=selectedRole){hideAccountViews();setRole(role);loginPage.hidden=false;document.getElementById('communityNav').classList.remove('active');document.getElementById('savedNav').classList.remove('active');document.querySelector('.nav-link:first-child').classList.remove('active');document.getElementById('hireNav').classList.toggle('active',role==='employer')}
function showFreelancerArea(user){hideAccountViews();document.querySelector('.welcome').hidden=false;document.querySelector('.search-panel').hidden=false;document.querySelector('.content-grid').hidden=false;document.querySelector('.nav-link:first-child').classList.add('active');document.getElementById('communityNav').classList.remove('active');document.getElementById('hireNav').classList.remove('active');const name=user?.name||localStorage.getItem('workwise-user-name')||'Jamie Davis';const initials=name.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase()||'JD';localStorage.setItem('workwise-user-name',name);localStorage.setItem('workwise-user-initials',initials);document.getElementById('accountName').textContent=name;document.querySelector('#accountButton .avatar').textContent=initials;document.querySelector('.mini-profile strong').textContent=name;document.querySelector('.avatar.large').textContent=initials;apiRequest('/api/profile').then(renderProfile).catch(()=>{})}
function renderProfile(profileData){const name=profileData.name||'Workwise member';const profile=profileData.profile||{};const initials=name.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase()||'WM';document.getElementById('accountName').textContent=name;document.querySelector('#accountButton .avatar').textContent=initials;document.getElementById('profileAvatar').textContent=initials;document.getElementById('profileDisplayName').textContent=name;document.getElementById('profileDisplayTitle').textContent=profile.title||'Add a professional title';const location=document.getElementById('profileDisplayLocation');location.textContent=profile.location||'';location.hidden=!profile.location;const portfolio=document.getElementById('profilePortfolioPreview');portfolio.href=profile.portfolioUrl||'#';portfolio.hidden=!profile.portfolioUrl;const bio=document.getElementById('profileBioPreview');bio.textContent=profile.bio||'';bio.hidden=!profile.bio;const tags=document.getElementById('profileSkillPreview');tags.replaceChildren();(profile.skills||[]).forEach(skill=>{const tag=document.createElement('span');tag.textContent=skill;tags.append(tag)});const strength=Math.min(100,(name?10:0)+(profile.title?20:0)+(profile.location?10:0)+(profile.bio?25:0)+(profile.skills?.length?25:0)+(profile.portfolioUrl?10:0));document.getElementById('profileStrength').textContent=`${strength}%`;document.getElementById('profileTopStrength').textContent=`${strength}%`;document.getElementById('profileProgressBar').style.width=`${strength}%`;localStorage.setItem('workwise-user-name',name);localStorage.setItem('workwise-user-initials',initials)}
async function openProfileEditor(){try{const data=await apiRequest('/api/profile');try{document.getElementById('privacyShowEmail').checked=(await apiRequest('/api/privacy')).showEmail}catch{}const profile=data.profile||{};document.getElementById('profileNameInput').value=data.name||'';document.getElementById('profileTitleInput').value=profile.title||'';document.getElementById('profileLocationInput').value=profile.location||'';document.getElementById('profileBioInput').value=profile.bio||'';document.getElementById('profileSkillsInput').value=(profile.skills||[]).join(', ');document.getElementById('profilePortfolioInput').value=profile.portfolioUrl||'';showProfileError('');document.getElementById('profileDialog').showModal()}catch(error){if(error.message.includes('Sign in'))showLogin(selectedRole);else showToast(error.message)}}
function showProfileError(message){const node=document.getElementById('profileFormError');node.textContent=message||'';node.hidden=!message}
function setHeaderAuth(user){
  updateBillingBanner(user);
  const nav=document.querySelector('.main-nav');let adminLink=document.getElementById('adminNav');
  if(user?.role==='admin'){if(!adminLink){adminLink=document.createElement('a');adminLink.id='adminNav';adminLink.className='nav-link';adminLink.href='admin.html';adminLink.textContent='Admin dashboard';nav.append(adminLink)}}else adminLink?.remove();const button=document.getElementById('headerAuthButton');button.textContent=user?'Sign out':'Sign in';button.dataset.signedIn=user?'true':'false';if(user?.role==='freelancer'||user?.role==='employer')selectedRole=user.role}
function showEmployerArea(user){hideAccountViews();employerPage.hidden=false;document.querySelectorAll('.nav-link').forEach(link=>link.classList.remove('active'));document.getElementById('hireNav').classList.add('active');if(user){localStorage.setItem('workwise-user-name',user.name);localStorage.setItem('workwise-user-initials',user.name.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase())}document.getElementById('accountName').textContent=localStorage.getItem('workwise-user-name')||'Employer';document.querySelector('#accountButton .avatar').textContent=localStorage.getItem('workwise-user-initials')||'EM';renderPostedJobs();apiRequest('/api/profile').then(renderProfile).catch(()=>{})}
function showAccountError(message){const node=document.getElementById('accountError');node.textContent=message||'';node.hidden=!message}
async function apiRequest(url,options={}){const response=await fetch(url,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'The request could not be completed.');return result}
async function openRoleWorkspace(role){try{const user=await apiRequest('/api/auth/me');if(user.role!==role){showLogin(role);return}setRole(role);role==='employer'?showEmployerArea(user):showFreelancerArea(user)}catch{showLogin(role)}}
async function deleteMyJob(job){
  if(!confirm(`Delete “${job.title}”? It will be removed from the marketplace and cannot be undone.`))return;
  try{
    await apiRequest(`/api/employer/jobs/${encodeURIComponent(job.id)}`,{method:'DELETE'});
    const at=jobs.findIndex(item=>String(item.id)===String(job.id));if(at>=0)jobs.splice(at,1);
    render();await renderPostedJobs();showToast('Job deleted')
  }catch(error){showToast(error.message)}
}
async function renderPostedJobs(){
  let posted=[],received=[];
  try{[posted,received]=await Promise.all([apiRequest('/api/employer/jobs'),apiRequest('/api/employer/applications')])}catch(error){console.warn('Could not load employer workspace:',error.message)}
  const ownIds=new Set(posted.map(job=>String(job.id)));
  received=received.filter(application=>ownIds.has(String(application.jobId)));
  document.getElementById('employerJobCount').textContent=posted.length;
  document.getElementById('employerProposalCount').textContent=received.length;document.getElementById('tabProposalCount').textContent=received.length;
  const container=document.getElementById('postedJobs');container.replaceChildren();
  if(!posted.length){const empty=document.createElement('div');empty.className='posted-empty';empty.textContent='Your published jobs will appear here.';container.append(empty)}
  else posted.slice().reverse().forEach(job=>{const card=document.createElement('article');card.className='posted-job';const title=document.createElement('strong');title.textContent=job.title;const meta=document.createElement('span');meta.textContent=`${job.category} · ${job.type} · ${job.budget}`;const status=document.createElement('span');status.className='job-status';status.textContent='Published';const count=received.filter(application=>String(application.jobId)===String(job.id)).length;const proposals=document.createElement('span');proposals.className='proposal-count';proposals.textContent=`${count} ${count===1?'proposal':'proposals'}`;const remove=document.createElement('button');remove.type='button';remove.className='posted-delete';remove.textContent='Delete job';remove.addEventListener('click',()=>deleteMyJob(job));card.append(title,meta,status,proposals,remove);container.append(card)});
  const proposalContainer=document.getElementById('employerProposals');proposalContainer.replaceChildren();
  if(!received.length){const empty=document.createElement('div');empty.className='posted-empty';empty.textContent='Applications for your jobs will appear here.';proposalContainer.append(empty);return}
  received.slice().reverse().forEach(application=>{
    const card=document.createElement('article');card.className='employer-proposal';
    const applicant=document.createElement('strong');applicant.textContent=application.applicantName;
    const details=document.createElement('div');details.className='proposal-job';details.textContent=[application.jobTitle,application.rate,application.availability&&`Available: ${application.availability}`].filter(Boolean).join(' · ');
    const letter=document.createElement('p');letter.textContent=application.coverLetter;const person=document.createElement('small');person.className='proposal-person';person.textContent=[application.email,application.applicantProfile?.title,application.applicantProfile?.location].filter(Boolean).join(' · ');card.append(applicant,person);if(application.applicantProfile?.skills?.length){const skills=document.createElement('small');skills.className='proposal-skills';skills.textContent='Skills: '+application.applicantProfile.skills.join(', ');card.append(skills)}card.append(details,letter);
    const files=document.createElement('div');files.className='proposal-files';
    for(const kind of ['resume','coverPhoto']){const name=application.attachments?.[kind];if(!name)continue;const link=document.createElement('a');link.className='proposal-file';link.textContent=`↓ ${name}`;link.href=`/api/applications/${encodeURIComponent(application.id)}/attachments/${kind}`;link.download=name;files.append(link)}
    card.append(files);
    const actions=document.createElement('div');actions.className='proposal-actions';
    const message=document.createElement('button');message.type='button';message.className='proposal-message-btn';message.textContent='✉ Message';
    message.addEventListener('click',async()=>{message.disabled=true;try{const result=await apiRequest(`/api/employer/applications/${encodeURIComponent(application.id)}/conversation`,{method:'POST'});window.openCommunityConversation?.(result.conversationId)}catch(error){showToast(error.message)}finally{message.disabled=false}});
    actions.append(message);
    if(application.status==='accepted'){const badge=document.createElement('span');badge.className='proposal-badge';badge.textContent='✓ Accepted';actions.append(badge)}
    else{const accept=document.createElement('button');accept.type='button';accept.className='proposal-accept-btn';accept.textContent='Accept proposal';accept.addEventListener('click',async()=>{accept.disabled=true;try{await apiRequest(`/api/employer/applications/${encodeURIComponent(application.id)}/accept`,{method:'POST'});await renderPostedJobs();showToast('Proposal accepted. You can keep chatting in Messages.')}catch(error){showToast(error.message);accept.disabled=false}});actions.append(accept)}
    card.append(actions);proposalContainer.append(card)
  })
}
function addToMarketplace(job){const client=job.client||'Workwise client',level=(job.level||'Intermediate').replace(' level',''),existing=jobs.find(item=>String(item.id)===String(job.id));const mapped={id:job.id,company:client,initial:client.slice(0,1).toUpperCase(),logo:existing?.logo||7,title:job.title,rating:job.rating||existing?.rating||'New client',verified:Boolean(job.verified),desc:job.description||existing?.desc||'',tags:job.tags?.length?job.tags:existing?.tags||[job.category,level+' level'],type:(job.type||'Fixed price').toLowerCase()==='hourly'?'hourly':'fixed',pay:job.budget||existing?.pay||'',level,duration:job.duration||existing?.duration||'Project duration TBD',proposals:job.proposals||'0',posted:0,client:existing?.client||'Workwise',budget:Number(String(job.budget||existing?.budget||'').replace(/[^0-9.]/g,''))||0};if(existing)Object.assign(existing,mapped);else jobs.push(mapped)}

roleOptions.forEach(button=>button.addEventListener('click',()=>setRole(button.dataset.role)));
document.getElementById('accountModeToggle').addEventListener('click',event=>{accountMode=accountMode==='signin'?'register':'signin';const registering=accountMode==='register';document.getElementById('modePrompt').textContent=registering?'Already have an account?':'New to Workwise?';event.currentTarget.textContent=registering?'Sign in':'Create an account';document.getElementById('fullNameField').hidden=!registering;document.getElementById('loginName').required=registering;document.getElementById('loginPassword').autocomplete=registering?'new-password':'current-password';document.getElementById('accountSubmit').innerHTML=registering?'Create account <span>↗</span>':'Sign in <span>↗</span>';document.getElementById('forgotPassword').hidden=registering;showAccountError('')});
document.getElementById('hireNav').addEventListener('click',event=>{event.preventDefault();openRoleWorkspace('employer')});
document.getElementById('accountButton').addEventListener('click',async()=>{try{const user=await apiRequest('/api/auth/me');if(user.role==='employer')showEmployerArea(user);else showFreelancerArea(user)}catch{showLogin(selectedRole)}});
document.getElementById('headerAuthButton').addEventListener('click',async()=>{if(document.getElementById('headerAuthButton').dataset.signedIn==='true'){try{await apiRequest('/api/auth/logout',{method:'POST'});localStorage.removeItem('workwise-role');setHeaderAuth(null);showLogin(selectedRole)}catch(error){showToast(error.message)}}else showLogin(selectedRole)});
document.getElementById('loginBack').addEventListener('click',()=>showFreelancerArea());
document.getElementById('forgotPassword').addEventListener('click',event=>{event.preventDefault();openRecovery()});
loginForm.addEventListener('submit',async event=>{event.preventDefault();if(!loginForm.reportValidity())return;const submit=document.getElementById('accountSubmit');submit.disabled=true;showAccountError('');try{const registering=accountMode==='register';const body={email:document.getElementById('loginEmail').value.trim(),password:document.getElementById('loginPassword').value,role:selectedRole,rememberMe:document.getElementById('rememberAccount').checked};if(registering)body.name=document.getElementById('loginName').value.trim();const user=await apiRequest(registering?'/api/auth/register':'/api/auth/login',{method:'POST',body:JSON.stringify(body)});localStorage.setItem('workwise-role',user.role);setHeaderAuth(user);if(user.role==='employer')showEmployerArea(user);else showFreelancerArea(user)}catch(error){showAccountError(error.message)}finally{submit.disabled=false}});
document.getElementById('switchRole').addEventListener('click',async()=>{try{await apiRequest('/api/auth/logout',{method:'POST'});localStorage.removeItem('workwise-role');setHeaderAuth(null);showLogin('freelancer')}catch{showToast('Could not sign out. Please try again.')}});
document.getElementById('postJobForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;const submitBtn=form.querySelector('button[type=submit]');if(submitBtn.disabled)return;const job={title:document.getElementById('postTitle').value.trim(),category:document.getElementById('postCategory').value,level:document.getElementById('postLevel').value,description:document.getElementById('postDescription').value.trim(),type:document.getElementById('postType').value,budget:document.getElementById('postBudget').value.trim(),tags:[document.getElementById('postCategory').value]};submitBtn.disabled=true;try{await apiRequest('/api/jobs',{method:'POST',body:JSON.stringify(job)});form.reset();await refreshMarketplaceJobs();await renderPostedJobs();showToast('Your job has been published')}catch(error){showToast(error.message)}finally{submitBtn.disabled=false}});
async function refreshMarketplaceJobs(){try{const response=await fetch('/api/jobs',{credentials:'same-origin'});if(!response.ok)throw new Error('Could not load posted jobs.');const serverJobs=await response.json();if(response.headers.get('X-Workwise-Seeds-Initialized')==='true'){const liveSeedIds=new Set(serverJobs.filter(job=>job.kind==='seed').map(job=>String(job.id)));for(let index=jobs.length-1;index>=0;index--){if(Number(jobs[index].id)>=1&&Number(jobs[index].id)<=8&&!liveSeedIds.has(String(jobs[index].id)))jobs.splice(index,1)}}serverJobs.forEach(addToMarketplace);render()}catch(error){console.warn('Could not load posted jobs from the server:',error.message)}}
refreshMarketplaceJobs();
if(localStorage.getItem('workwise-user-name')){document.getElementById('accountName').textContent=localStorage.getItem('workwise-user-name');document.querySelector('#accountButton .avatar').textContent=localStorage.getItem('workwise-user-initials')||'JD'}
apiRequest('/api/auth/me').then(setHeaderAuth).catch(()=>setHeaderAuth(null));
document.getElementById('profileBtn').addEventListener('click',openProfileEditor);
document.getElementById('employerEditProfile').addEventListener('click',openProfileEditor);
document.getElementById('editProfile').addEventListener('click',event=>{event.preventDefault();openProfileEditor()});
document.getElementById('profileDisplayName').addEventListener('click',openProfileEditor);
document.getElementById('tipLink').addEventListener('click',event=>{event.preventDefault();openProfileEditor()});
document.getElementById('closeProfileDialog').addEventListener('click',()=>document.getElementById('profileDialog').close());
document.getElementById('cancelProfileEdit').addEventListener('click',()=>document.getElementById('profileDialog').close());
document.getElementById('profileEditForm').addEventListener('submit',async event=>{event.preventDefault();const button=document.getElementById('saveProfileButton');button.disabled=true;showProfileError('');const body={name:document.getElementById('profileNameInput').value.trim(),profile:{title:document.getElementById('profileTitleInput').value.trim(),location:document.getElementById('profileLocationInput').value.trim(),bio:document.getElementById('profileBioInput').value.trim(),skills:document.getElementById('profileSkillsInput').value.split(',').map(skill=>skill.trim()).filter(Boolean),portfolioUrl:document.getElementById('profilePortfolioInput').value.trim()}};try{const updated=await apiRequest('/api/profile',{method:'PATCH',body:JSON.stringify(body)});renderProfile(updated);document.getElementById('profileDialog').close();showToast('Your profile has been saved')}catch(error){showProfileError(error.message)}finally{button.disabled=false}});
apiRequest('/api/profile').then(renderProfile).catch(()=>{});

function showHome(){
  hideAccountViews();
  document.querySelector('.welcome').hidden=false;document.querySelector('.search-panel').hidden=false;document.querySelector('.content-grid').hidden=false;
  document.querySelectorAll('.nav-link').forEach(link=>link.classList.remove('active'));
  document.querySelector('.nav-link:first-child').classList.add('active');
  if(typeof communityRefreshTimer!=='undefined'&&communityRefreshTimer)clearInterval(communityRefreshTimer);
  window.scrollTo(0,0)
}
document.querySelector('.nav-link:first-child').addEventListener('click',event=>{event.preventDefault();if(showSaved)document.getElementById('savedNav').click();showHome()});
document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();showHome()});
document.getElementById('savedNav').addEventListener('click',()=>{showHome();document.getElementById('savedNav').classList.toggle('active',showSaved);document.querySelector('.nav-link:first-child').classList.toggle('active',!showSaved)});
document.querySelectorAll('[data-jump]').forEach(link=>link.addEventListener('click',event=>{
  event.preventDefault();const target=link.dataset.jump;
  if(target==='messages')window.openCommunityConversation?.();
  else if(target==='browse')showHome();
  else document.getElementById(target)?.scrollIntoView({behavior:'smooth',block:'start'})
}));

// ================= password recovery (code by email) =================
const recoverDialog=document.getElementById('recoverDialog');
let recoverStep=1;
function recoverMessage(text,good){const box=document.getElementById('recoverMessage');box.hidden=!text;box.textContent=text||'';box.classList.toggle('good',Boolean(good))}
function openRecovery(){recoverStep=1;document.getElementById('recoverStep2').hidden=true;document.getElementById('recoverEmail').readOnly=false;document.getElementById('recoverEmail').value=document.getElementById('loginEmail').value;document.getElementById('recoverCode').value='';document.getElementById('recoverPassword').value='';document.getElementById('recoverSubmit').textContent='Send code';document.getElementById('recoverHelp').textContent='Enter the email you signed up with and we will email you a 6-digit code.';recoverMessage('');recoverDialog.showModal()}
document.getElementById('closeRecover').addEventListener('click',()=>recoverDialog.close());
document.getElementById('recoverCancel').addEventListener('click',()=>recoverDialog.close());
document.getElementById('recoverForm').addEventListener('submit',async event=>{
  event.preventDefault();const submit=document.getElementById('recoverSubmit');if(submit.disabled)return;submit.disabled=true;
  const email=document.getElementById('recoverEmail').value.trim();
  try{
    if(recoverStep===1){
      const result=await apiRequest('/api/auth/forgot',{method:'POST',body:JSON.stringify({email})});
      recoverStep=2;document.getElementById('recoverStep2').hidden=false;document.getElementById('recoverEmail').readOnly=true;submit.textContent='Reset password';
      document.getElementById('recoverHelp').textContent='Check your inbox (and spam folder) for the 6-digit code.';recoverMessage(result.message,true);document.getElementById('recoverCode').focus()
    }else{
      const result=await apiRequest('/api/auth/reset',{method:'POST',body:JSON.stringify({email,code:document.getElementById('recoverCode').value.trim(),newPassword:document.getElementById('recoverPassword').value})});
      recoverDialog.close();document.getElementById('loginEmail').value=email;document.getElementById('loginPassword').value='';showToast(result.message)
    }
  }catch(error){recoverMessage(error.message,false)}finally{submit.disabled=false}
});

// ================= plans & billing =================
const plansPage=document.getElementById('plansPage');
const fmtDate=iso=>new Date(iso).toLocaleDateString('en-GB',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'});
const planMoney=(plan,months=1)=>`${plan.currency} ${(plan.price*months).toLocaleString()}`;
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
async function updateBillingBanner(user){
  const banner=document.getElementById('billingBanner');
  if(!user||user.role==='admin'){banner.hidden=true;return}
  try{
    const {status}=await apiRequest('/api/billing');let text='';
    if(status.state==='trial')text=`Free period: ${status.daysLeft} day${status.daysLeft===1?'':'s'} left. Paid plans start on ${fmtDate(status.billingStartsAt)}.`;
    else if(status.state==='free')text=status.expired?'Your plan has ended. You are on the Free plan with limits.':'You are on the Free plan. Upgrade for unlimited use.';
    else if(status.state==='active'&&status.daysLeft<=7)text=`Your ${status.planName} plan ends in ${status.daysLeft} day${status.daysLeft===1?'':'s'}.`;
    document.getElementById('billingBannerText').textContent=text;banner.hidden=!text
  }catch{banner.hidden=true}
}
async function renderPlans(){
  let data;
  try{data=await apiRequest('/api/billing')}catch{const pub=await apiRequest('/api/billing/plans');data={status:{state:'public',billingStartsAt:pub.billingStartsAt},plans:pub.plans,freeLimits:pub.freeLimits,payments:[],instructions:''}}
  const {status,plans,freeLimits}=data;const signedIn=status.state!=='public';
  document.getElementById('plansIntro').textContent=status.state==='trial'||status.state==='public'&&new Date(status.billingStartsAt)>new Date()?`Everything is free until ${fmtDate(status.billingStartsAt)}. After that you can keep using the Free plan or upgrade.`:'Choose the plan that fits you.';
  const box=document.getElementById('planStatus');box.replaceChildren();
  const line=text=>{box.append(el('p','',text))};
  if(status.state==='trial')line(`You are in your free period: ${status.daysLeft} day${status.daysLeft===1?'':'s'} left (until ${fmtDate(status.billingStartsAt)}). Everything is unlimited until then.`);
  else if(status.state==='active')line(`${status.planName} is active until ${fmtDate(status.expiresAt)} (${status.daysLeft} days left).`);
  else if(status.state==='free'){line(status.expired?'Your paid plan has ended. You are on the Free plan.':'You are on the Free plan.');const roleUsage=window.workwiseCurrentUser?.role==='employer'?`Active jobs: ${status.usage.activeJobs} of ${freeLimits.activeJobs}`:`Proposals this month: ${status.usage.proposalsThisMonth} of ${freeLimits.proposalsPerMonth}`;line(roleUsage);line(`Messages this month: ${status.usage.messagesThisMonth} of ${freeLimits.messagesPerMonth}`)}
  else if(status.state==='exempt')line('Admin accounts do not need a plan.');
  else line('Sign in to see your plan and subscribe.');
  const grid=document.getElementById('planGrid');grid.replaceChildren();
  const freeCard=el('article','plan-card');freeCard.append(el('h3','','Free'),el('p','plan-price','0'),el('ul','plan-features'));
  [`Hirers: ${freeLimits.activeJobs} active job post`,`Freelancers: ${freeLimits.proposalsPerMonth} proposals per month`,`${freeLimits.messagesPerMonth} messages per month`,'Full privacy controls'].forEach(f=>freeCard.querySelector('ul').append(el('li','',f)));grid.append(freeCard);
  plans.forEach(plan=>{
    const card=el('article','plan-card featured');card.append(el('h3','',plan.name),el('p','plan-price',`${planMoney(plan)} / month`));const list=el('ul','plan-features');plan.features.forEach(f=>list.append(el('li','',f)));card.append(list);
    const choose=el('button','primary-btn',signedIn?'Choose this plan':'Sign in to subscribe');choose.type='button';
    choose.addEventListener('click',()=>{if(!signedIn){showLogin();return}document.getElementById('payPlan').value=plan.id;document.getElementById('payCard').scrollIntoView({behavior:'smooth'});document.getElementById('payReference').focus()});
    card.append(choose);grid.append(card)
  });
  const payCard=document.getElementById('payCard');payCard.hidden=!(signedIn&&status.state!=='exempt'&&plans.length);
  const instructionsBox=document.getElementById('payInstructions');instructionsBox.replaceChildren(document.createTextNode(data.instructions||''));
  const cardMatch=(data.instructions||'').match(/\b(?:\d{4}[ -]?){3}\d{4}\b/);
  if(cardMatch){const copy=el('button','link-btn','Copy card number');copy.type='button';copy.style.marginLeft='8px';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(cardMatch[0].replace(/\D/g,''));showToast('Card number copied')}catch{showToast('Select and copy the number manually')}});instructionsBox.append(copy)}
  const select=document.getElementById('payPlan');select.replaceChildren();plans.forEach(plan=>{const option=el('option','',`${plan.name} · ${planMoney(plan)} / month`);option.value=plan.id;select.append(option)});
  const paymentsCard=document.getElementById('paymentsCard'),list=document.getElementById('paymentList');list.replaceChildren();paymentsCard.hidden=!data.payments.length;
  data.payments.forEach(p=>{const row=el('div','payment-row');row.append(el('strong','',`${p.planName} · ${p.months} month${p.months>1?'s':''} · ${p.currency} ${p.amount.toLocaleString()}`),el('span',`payment-status ${p.status}`,p.status),el('small','',`Ref ${p.reference} · ${fmtDate(p.createdAt)}`));list.append(row)})
}
async function showPlans(){
  try{window.workwiseCurrentUser=await apiRequest('/api/auth/me')}catch{window.workwiseCurrentUser=null}
  hideAccountViews();plansPage.hidden=false;document.querySelectorAll('.nav-link').forEach(link=>link.classList.remove('active'));document.getElementById('plansNav').classList.add('active');window.scrollTo(0,0);
  try{await renderPlans()}catch(error){showToast(error.message)}
}
document.getElementById('plansNav').addEventListener('click',event=>{event.preventDefault();showPlans()});
document.getElementById('billingBannerLink').addEventListener('click',event=>{event.preventDefault();showPlans()});
document.getElementById('payForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=document.getElementById('paySubmit');if(button.disabled)return;button.disabled=true;
  try{await apiRequest('/api/billing/payments',{method:'POST',body:JSON.stringify({planId:document.getElementById('payPlan').value,months:Number(document.getElementById('payMonths').value),reference:document.getElementById('payReference').value.trim()})});
    document.getElementById('payReference').value='';showToast('Payment submitted. The administrator will confirm it shortly.');await renderPlans()}
  catch(error){showToast(error.message)}finally{button.disabled=false}
});

// ================= privacy controls =================
document.getElementById('privacyShowEmail').addEventListener('change',async event=>{
  try{await apiRequest('/api/privacy',{method:'PATCH',body:JSON.stringify({showEmail:event.target.checked})});showToast(event.target.checked?'Hirers can now see your email.':'Your email is hidden from hirers.')}
  catch(error){event.target.checked=!event.target.checked;showToast(error.message)}
});
document.getElementById('exportData').addEventListener('click',async()=>{
  try{const response=await fetch('/api/account/export',{credentials:'same-origin'});if(!response.ok)throw new Error('Could not export your data.');
    const link=document.createElement('a');link.href=URL.createObjectURL(await response.blob());link.download='workwise-my-data.json';document.body.append(link);link.click();link.remove()}
  catch(error){showToast(error.message)}
});
document.getElementById('deleteAccount').addEventListener('click',async()=>{
  const password=prompt('This permanently deletes your account, jobs, proposals, messages and files.\n\nType your password to confirm:');if(!password)return;
  try{await apiRequest('/api/account',{method:'DELETE',body:JSON.stringify({password})});document.getElementById('profileDialog').close?.();showToast('Your account has been deleted.');setTimeout(()=>window.location.reload(),1200)}
  catch(error){showToast(error.message)}
});

// "Send a new code": works immediately (3-second pause only stops accidental double-clicks)
document.getElementById('recoverResend').addEventListener('click',async()=>{
  const button=document.getElementById('recoverResend');if(button.disabled)return;button.disabled=true;
  try{
    const result=await apiRequest('/api/auth/forgot',{method:'POST',body:JSON.stringify({email:document.getElementById('recoverEmail').value.trim()})});
    document.getElementById('recoverCode').value='';document.getElementById('recoverCode').focus();recoverMessage('A new code is on its way. Older codes no longer work. Check spam if you do not see it.',true)
  }catch(error){recoverMessage(error.message,false)}
  let left=3;const timer=setInterval(()=>{left-=1;button.textContent=left>0?`Send a new code (${left})`:'Send a new code';if(left<=0){clearInterval(timer);button.disabled=false}},1000);button.textContent='Send a new code (3)'
});
