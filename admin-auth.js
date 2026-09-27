document.documentElement.classList.remove('admin-authenticated');
fetch('/api/auth/me',{credentials:'same-origin'}).then(response=>response.ok?response.json():null).then(user=>{
  if(!user||user.role!=='admin'){
    localStorage.removeItem('workwise-admin-auth');
    window.location.replace('admin-login.html');
    return;
  }
  document.documentElement.classList.add('admin-authenticated');
  document.getElementById('adminLogout').addEventListener('click',async()=>{
    await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});
    localStorage.removeItem('workwise-admin-auth');
    window.location.replace('admin-login.html');
  });
}).catch(()=>window.location.replace('admin-login.html'));
