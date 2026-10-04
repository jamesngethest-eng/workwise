let communityConversations=[];
let activeConversation=null;
let communityRefreshTimer=null;
const communityPage=document.getElementById('communityPage');
const communityShell=document.querySelector('.community-shell');
const conversationList=document.getElementById('conversationList');
const chatPanel=document.getElementById('chatPanel');

async function communityRequest(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||'Could not load your messages.');
  return result;
}
function safeText(value){const node=document.createElement('span');node.textContent=value||'';return node.innerHTML}
function shortTime(value){if(!value)return '';const date=new Date(value);if(Number.isNaN(date.getTime()))return '';const today=new Date();return date.toDateString()===today.toDateString()?date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):date.toLocaleDateString([],{month:'short',day:'numeric'})}
function peerInitials(conversation){return (conversation.peer?.name||'W').split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase()}
function renderConversations(){
  const query=document.getElementById('conversationSearch').value.trim().toLowerCase();
  const filtered=communityConversations.filter(item=>`${item.peer?.name||''} ${item.jobTitle||''} ${item.lastMessage?.text||''}`.toLowerCase().includes(query));
  conversationList.replaceChildren();
  if(!filtered.length){const empty=document.createElement('div');empty.className='chat-empty';const message=document.createElement('p');message.textContent=query?'No conversations match your search.':({admin:'No chats yet. Open Admin → Clients to message a hirer.',employer:'No chats yet. Open a proposal under Hire talent and click Message to start one.'}[window.workwiseCurrentUser?.role]||'No chats yet. When a hirer messages you about your proposal, it will appear here.');empty.append(message);conversationList.append(empty);return}
  filtered.forEach(conversation=>{
    const button=document.createElement('button');button.type='button';button.className=`conversation-item ${activeConversation?.id===conversation.id?'active':''}`;button.dataset.conversation=conversation.id;
    const avatar=document.createElement('span');avatar.className='avatar logo-1';avatar.textContent=peerInitials(conversation);
    const copy=document.createElement('span');copy.className='conversation-item-copy';
    const top=document.createElement('span');top.className='conversation-item-top';const name=document.createElement('strong');name.textContent=conversation.peer?.name||'Workwise member';const time=document.createElement('time');time.textContent=shortTime(conversation.lastMessage?.sentAt||conversation.updatedAt);top.append(name,time);
    const preview=document.createElement('p');preview.textContent=conversation.lastMessage?.text||(conversation.lastMessage?.attachments?.length?'📎 Attachment':'')||conversation.jobTitle||'Start a conversation';copy.append(top,preview);button.append(avatar,copy);
    if(activeConversation?.id===conversation.id)button.classList.add('active');conversationList.append(button);
  });
}
function renderMessages(){
  if(!activeConversation)return;
  const list=document.getElementById('chatMessages');if(!list)return;
  const shouldScroll=list.scrollHeight-list.scrollTop-list.clientHeight<80;
  list.replaceChildren();
  const context=document.createElement('div');context.className='message-date';context.textContent=activeConversation.jobTitle||'Direct message';list.append(context);
  activeConversation.messages.forEach(message=>{
    const mine=message.senderId===window.workwiseCurrentUser?.id;
    const row=document.createElement('div');row.className=`message-row ${mine?'mine':''}`;
    if(!mine){const avatar=document.createElement('span');avatar.className='avatar logo-1';avatar.textContent=peerInitials(activeConversation);row.append(avatar)}
    const bubble=document.createElement('div');bubble.className='message-bubble';if(message.text){const text=document.createElement('div');text.textContent=message.text;bubble.append(text)}if(message.attachments?.length)bubble.append(renderAttachments(message.attachments));
    const time=document.createElement('time');time.className='message-time';time.textContent=shortTime(message.sentAt);
    row.append(bubble,time);list.append(row);
  });
  if(shouldScroll)list.scrollTop=list.scrollHeight;
}
function renderChat(){
  if(!activeConversation)return;
  communityShell.classList.add('has-chat');chatPanel.replaceChildren();
  const header=document.createElement('header');header.className='chat-header';
  const back=document.createElement('button');back.type='button';back.className='chat-back';back.setAttribute('aria-label','Back to conversations');back.textContent='←';back.addEventListener('click',()=>{if(communityRefreshTimer)clearInterval(communityRefreshTimer);communityShell.classList.remove('has-chat')});
  const avatar=document.createElement('span');avatar.className='avatar logo-1';avatar.textContent=peerInitials(activeConversation);
  const person=document.createElement('span');person.className='chat-person';const name=document.createElement('strong');name.textContent=activeConversation.peer?.name||'Workwise member';const status=document.createElement('span');status.textContent=activeConversation.jobTitle||'Direct message';person.append(name,status);header.append(back,avatar,person);
  const messages=document.createElement('div');messages.className='chat-messages';messages.id='chatMessages';
  const form=document.createElement('form');form.className='chat-composer';form.id='chatComposer';
  const input=document.createElement('textarea');input.id='messageInput';input.rows=1;input.maxLength=4000;input.placeholder='Write a message…';input.setAttribute('aria-label','Write a message');
  const send=document.createElement('button');send.type='submit';send.id='sendMessage';send.disabled=true;send.textContent='Send ↗';
  let pending=[];
  const tray=document.createElement('div');tray.className='attach-tray';tray.hidden=true;
  const uploadStatus=document.createElement('div');uploadStatus.className='attach-status';uploadStatus.hidden=true;
  const refreshSend=()=>{send.disabled=!(input.value.trim()||pending.length)};
  const renderTray=()=>{tray.replaceChildren();tray.hidden=!pending.length;const groups=new Map();pending.forEach((item,index)=>{const key=item.path?item.path.split('/')[0]:`#${index}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item)});
    groups.forEach((items,key)=>{const chip=document.createElement('span');chip.className='attach-chip';const total=items.reduce((sum,item)=>sum+item.file.size,0);
      chip.textContent=key.startsWith('#')?`${attachIcon(items[0].file)} ${items[0].file.name} · ${formatSize(total)}`:`📁 ${key} · ${items.length} file${items.length===1?'':'s'} · ${formatSize(total)}`;
      const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove attachment');remove.textContent='×';remove.addEventListener('click',()=>{pending=pending.filter(item=>!items.includes(item));renderTray()});chip.append(remove);tray.append(chip)});refreshSend()};
  const addFiles=list=>{const limit=window.workwiseUploadLimit||{maxMb:50,maxFiles:50};for(const file of list){if(pending.length>=limit.maxFiles){showToast(`You can attach up to ${limit.maxFiles} files at once.`);break}if(!file.size)continue;if(file.size>limit.maxMb*1048576){showToast(`“${file.name}” is larger than ${limit.maxMb} MB.`);continue}const relative=file.webkitRelativePath||'';pending.push({file,path:relative?relative.split('/').slice(0,-1).join('/'):''})}renderTray()};
  const attach=document.createElement('button');attach.type='button';attach.className='attach-btn';attach.id='attachButton';attach.title='Attach photos, videos, files or a folder';attach.setAttribute('aria-label','Attach files');attach.textContent='📎';
  const menu=document.createElement('div');menu.className='attach-menu';menu.hidden=true;
  const makePicker=(label,configure)=>{const picker=document.createElement('input');picker.type='file';picker.multiple=true;picker.hidden=true;configure(picker);picker.addEventListener('change',()=>{addFiles([...picker.files]);picker.value='';menu.hidden=true});const item=document.createElement('button');item.type='button';item.textContent=label;item.addEventListener('click',()=>picker.click());menu.append(item,picker)};
  makePicker('🖼  Photos & videos',picker=>{picker.accept='image/*,video/*';picker.id='pickMedia'});
  makePicker('📄  Files',picker=>{picker.id='pickFiles'});
  makePicker('📁  Folder',picker=>{picker.webkitdirectory=true;picker.id='pickFolder'});
  attach.addEventListener('click',()=>{menu.hidden=!menu.hidden});
  form.append(attach,menu,input,send);
  chatPanel.ondragover=event=>event.preventDefault();chatPanel.ondrop=event=>{event.preventDefault();if(event.dataTransfer?.files?.length)addFiles([...event.dataTransfer.files])};
  chatPanel.onclick=event=>{if(!menu.hidden&&!menu.contains(event.target)&&event.target!==attach)menu.hidden=true};
  const note=document.createElement('div');note.className='chat-note';note.textContent='Keep project communication here so you and your partner can find it later.';
  chatPanel.append(header,messages,tray,uploadStatus,form,note);renderMessages();
  input.addEventListener('input',refreshSend);
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();form.requestSubmit()}});
  form.addEventListener('submit',async event=>{
    event.preventDefault();const message=input.value.trim();if(!message&&!pending.length)return;send.disabled=true;attach.disabled=true;
    try{
      const ids=[];
      for(let i=0;i<pending.length;i++){uploadStatus.hidden=false;const prefix=`Uploading ${i+1} of ${pending.length}: ${pending[i].file.name}`;uploadStatus.textContent=prefix;const result=await uploadFile(activeConversation.id,pending[i],fraction=>{uploadStatus.textContent=`${prefix} · ${Math.round(fraction*100)}%`});ids.push(result.id)}
      await communityRequest(`/api/conversations/${encodeURIComponent(activeConversation.id)}/messages`,{method:'POST',body:JSON.stringify({message,attachments:ids})});
      input.value='';pending=[];renderTray();uploadStatus.hidden=true;await refreshConversation(activeConversation.id);input.focus()
    }catch(error){showToast(error.message);uploadStatus.hidden=true}
    finally{attach.disabled=false;refreshSend()}
  });
  if(communityRefreshTimer)clearInterval(communityRefreshTimer);
  communityRefreshTimer=setInterval(()=>refreshConversation(activeConversation.id).catch(()=>{}),5000);
}
async function refreshConversation(id){
  const updated=await communityRequest(`/api/conversations/${encodeURIComponent(id)}`);
  if(activeConversation?.id!==id)return;
  activeConversation=updated;
  communityConversations=communityConversations.map(item=>item.id===id?updated:item);
  renderConversations();renderMessages();
}
async function showCommunity(conversationId=null){
  try{
    const user=await communityRequest('/api/auth/me');window.workwiseCurrentUser=user;
    communityConversations=await communityRequest('/api/conversations');
    hideAccountViews();
    communityPage.hidden=false;document.getElementById('communityNav').classList.add('active');document.getElementById('savedNav').classList.remove('active');document.querySelector('.nav-link:first-child').classList.remove('active');
    activeConversation=null;communityShell.classList.remove('has-chat');renderConversations();
    if(conversationId){const conversation=communityConversations.find(item=>item.id===conversationId);if(conversation){activeConversation=await communityRequest(`/api/conversations/${encodeURIComponent(conversationId)}`);renderConversations();renderChat()}}
  }catch(error){if(error.message.includes('Sign in'))showLogin();else showToast(error.message)}
}
function showJobs(){activeConversation=null;showHome()}
function formatSize(bytes){if(bytes<1024)return `${bytes} B`;if(bytes<1048576)return `${Math.round(bytes/1024)} KB`;return `${(bytes/1048576).toFixed(1)} MB`}
function attachIcon(file){return file.type?.startsWith('image/')?'🖼':file.type?.startsWith('video/')?'🎬':'📄'}
function uploadFile(conversationId,item,onProgress){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST',`/api/conversations/${encodeURIComponent(conversationId)}/files`);xhr.withCredentials=true;
    xhr.setRequestHeader('X-File-Name',encodeURIComponent(item.file.name));xhr.setRequestHeader('X-File-Path',encodeURIComponent(item.path||''));xhr.setRequestHeader('Content-Type','application/octet-stream');
    xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(event.loaded/event.total)};
    xhr.onload=()=>{let result={};try{result=JSON.parse(xhr.responseText)}catch{}xhr.status>=200&&xhr.status<300?resolve(result):reject(new Error(result.error||'Upload failed.'))};
    xhr.onerror=()=>reject(new Error('Upload failed. Check your connection and try again.'));xhr.send(item.file)
  })
}
function renderAttachments(list){
  const wrap=document.createElement('div');wrap.className='msg-attachments';const folders=new Map(),loose=[];
  list.forEach(item=>{if(item.path){const key=item.path.split('/')[0];if(!folders.has(key))folders.set(key,[]);folders.get(key).push(item)}else loose.push(item)});
  const make=item=>{const url=`/api/files/${encodeURIComponent(item.id)}`;
    if(item.kind==='image'){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';const img=document.createElement('img');img.className='msg-img';img.loading='lazy';img.alt=item.name;img.src=url;link.append(img);return link}
    if(item.kind==='video'){const box=document.createElement('div');const video=document.createElement('video');video.className='msg-video';video.controls=true;video.preload='metadata';video.src=url;const save=document.createElement('a');save.className='msg-file';save.href=`${url}?download=1`;save.textContent=`⬇ ${item.name} · ${formatSize(item.size)}`;box.append(video,save);return box}
    const link=document.createElement('a');link.className='msg-file';link.href=`${url}?download=1`;link.textContent=`📄 ${item.name} · ${formatSize(item.size)}`;return link};
  loose.forEach(item=>wrap.append(make(item)));
  folders.forEach((items,key)=>{const details=document.createElement('details');details.className='msg-folder';const summary=document.createElement('summary');summary.textContent=`📁 ${key} · ${items.length} file${items.length===1?'':'s'}`;details.append(summary);
    items.forEach(item=>{const row=document.createElement('a');row.className='msg-file';row.href=`/api/files/${encodeURIComponent(item.id)}?download=1`;row.textContent=`${[...item.path.split('/').slice(1),item.name].join('/')} · ${formatSize(item.size)}`;details.append(row)});wrap.append(details)});
  return wrap
}
fetch('/api/files/config').then(response=>response.ok?response.json():null).then(config=>{if(config)window.workwiseUploadLimit=config}).catch(()=>{});
window.openCommunityConversation=id=>showCommunity(id);
document.getElementById('communityNav').addEventListener('click',event=>{event.preventDefault();showCommunity()});
document.getElementById('backToJobs').addEventListener('click',showJobs);
document.getElementById('conversationSearch').addEventListener('input',renderConversations);
conversationList.addEventListener('click',async event=>{const button=event.target.closest('[data-conversation]');if(!button)return;try{activeConversation=await communityRequest(`/api/conversations/${encodeURIComponent(button.dataset.conversation)}`);renderConversations();renderChat()}catch(error){showToast(error.message)}});
document.getElementById('newMessage').addEventListener('click',()=>{const role=window.workwiseCurrentUser?.role;if(role==='admin')window.location.href='admin.html#clients';else if(role==='employer')openRoleWorkspace('employer').then(()=>document.getElementById('proposalsSection')?.scrollIntoView({behavior:'smooth'}));else showToast('Hirers start the conversation. It will appear in your list.')});
const communityQuery=new URLSearchParams(window.location.search);
if(communityQuery.get('community')==='1')showCommunity(communityQuery.get('conversation'));
