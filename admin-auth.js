document.documentElement.classList.remove('admin-authenticated');
const adminAuthButton=document.getElementById('adminAuthButton');
const adminLogoutButton=document.getElementById('adminLogout');
function setAdminAuthState(signedIn){
  if(!adminAuthButton) return;
  adminAuthButton.textContent=signedIn?'Admin signed in':'Admin sign in';
  adminAuthButton.dataset.signedIn=signedIn?'true':'false';
}
fetch('/api/auth/me',{credentials:'same-origin'}).then(response=>response.ok?response.json():null).then(user=>{
  if(!user||user.role!=='admin'){
    localStorage.removeItem('workwise-admin-auth');
    setAdminAuthState(false);
    if(adminLogoutButton) adminLogoutButton.hidden=true;
    if(adminAuthButton) adminAuthButton.addEventListener('click',()=>window.location.replace('admin-login.html'));
    return;
  }
  document.documentElement.classList.add('admin-authenticated');
  setAdminAuthState(true);
  if(adminLogoutButton) adminLogoutButton.hidden=false;
  if(adminAuthButton) adminAuthButton.addEventListener('click',async()=>{
    await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});
    localStorage.removeItem('workwise-admin-auth');
    setAdminAuthState(false);
    window.location.replace('admin-login.html');
  });
  if(adminLogoutButton) adminLogoutButton.addEventListener('click',async()=>{
    await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});
    localStorage.removeItem('workwise-admin-auth');
    window.location.replace('admin-login.html');
  });
}).catch(()=>{
  setAdminAuthState(false);
  if(adminLogoutButton) adminLogoutButton.hidden=true;
  if(adminAuthButton) adminAuthButton.addEventListener('click',()=>window.location.replace('admin-login.html'));
  window.location.replace('admin-login.html');
});
