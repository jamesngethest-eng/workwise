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
  if(!filtered.length){const empty=document.createElement('div');empty.className='chat-empty';const message=document.createElement('p');message.textContent=query?'No conversations match your search.':'No chats yet. A conversation opens when a hirer accepts your proposal.';empty.append(message);conversationList.append(empty);return}
  filtered.forEach(conversation=>{
    const button=document.createElement('button');button.type='button';button.className=`conversation-item ${activeConversation?.id===conversation.id?'active':''}`;button.dataset.conversation=conversation.id;
    const avatar=document.createElement('span');avatar.className='avatar logo-1';avatar.textContent=peerInitials(conversation);
    const copy=document.createElement('span');copy.className='conversation-item-copy';
    const top=document.createElement('span');top.className='conversation-item-top';const name=document.createElement('strong');name.textContent=conversation.peer?.name||'Workwise member';const time=document.createElement('time');time.textContent=shortTime(conversation.lastMessage?.sentAt||conversation.updatedAt);top.append(name,time);
    const preview=document.createElement('p');preview.textContent=conversation.lastMessage?.text||conversation.jobTitle||'Start a conversation';copy.append(top,preview);button.append(avatar,copy);
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
    const bubble=document.createElement('div');bubble.className='message-bubble';bubble.textContent=message.text;
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
  const send=document.createElement('button');send.type='submit';send.id='sendMessage';send.disabled=true;send.textContent='Send ↗';form.append(input,send);
  const note=document.createElement('div');note.className='chat-note';note.textContent='Keep project communication here so you and your partner can find it later.';
  chatPanel.append(header,messages,form,note);renderMessages();
  input.addEventListener('input',()=>{send.disabled=!input.value.trim()});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();form.requestSubmit()}});
  form.addEventListener('submit',async event=>{
    event.preventDefault();const message=input.value.trim();if(!message)return;send.disabled=true;
    try{await communityRequest(`/api/conversations/${encodeURIComponent(activeConversation.id)}/messages`,{method:'POST',body:JSON.stringify({message})});input.value='';await refreshConversation(activeConversation.id);input.focus()}
    catch(error){showToast(error.message);send.disabled=false}
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
    document.querySelector('.welcome').hidden=true;document.querySelector('.search-panel').hidden=true;document.querySelector('.content-grid').hidden=true;
    document.getElementById('loginPage').hidden=true;document.getElementById('employerPage').hidden=true;
    communityPage.hidden=false;document.getElementById('communityNav').classList.add('active');document.getElementById('savedNav').classList.remove('active');document.querySelector('.nav-link:first-child').classList.remove('active');
    activeConversation=null;communityShell.classList.remove('has-chat');renderConversations();
    if(conversationId){const conversation=communityConversations.find(item=>item.id===conversationId);if(conversation){activeConversation=await communityRequest(`/api/conversations/${encodeURIComponent(conversationId)}`);renderConversations();renderChat()}}
  }catch(error){if(error.message.includes('Sign in'))showLogin();else showToast(error.message)}
}
function showJobs(){if(communityRefreshTimer)clearInterval(communityRefreshTimer);activeConversation=null;communityPage.hidden=true;document.querySelector('.welcome').hidden=false;document.querySelector('.search-panel').hidden=false;document.querySelector('.content-grid').hidden=false;document.getElementById('communityNav').classList.remove('active');document.querySelector('.nav-link:first-child').classList.add('active')}
window.openCommunityConversation=id=>showCommunity(id);
document.getElementById('communityNav').addEventListener('click',event=>{event.preventDefault();showCommunity()});
document.getElementById('backToJobs').addEventListener('click',showJobs);
document.getElementById('conversationSearch').addEventListener('input',renderConversations);
conversationList.addEventListener('click',async event=>{const button=event.target.closest('[data-conversation]');if(!button)return;try{activeConversation=await communityRequest(`/api/conversations/${encodeURIComponent(button.dataset.conversation)}`);renderConversations();renderChat()}catch(error){showToast(error.message)}});
document.getElementById('newMessage').addEventListener('click',()=>showToast('Chat opens after a hirer accepts your proposal.'));
const communityQuery=new URLSearchParams(window.location.search);
if(communityQuery.get('community')==='1')showCommunity(communityQuery.get('conversation'));
