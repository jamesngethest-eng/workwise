const loginForm=document.getElementById('adminLoginForm');
const emailInput=document.getElementById('adminEmail');
const passwordInput=document.getElementById('adminPassword');
const loginError=document.getElementById('loginError');
let setupMode=false;
let setupKeyRequired=false;

async function initializeAdminLogin(){
  try{
    const current=await fetch('/api/auth/me',{credentials:'same-origin'});
    if(current.ok){const user=await current.json();if(user.role==='admin'){localStorage.setItem('workwise-admin-auth','signed-in');window.location.replace('admin.html');return}}
    const response=await fetch('/api/admin/setup-needed');
    const result=await response.json();
    setupMode=Boolean(result.needed);
    setupKeyRequired=Boolean(result.setupKeyRequired);
    if(setupMode){
      document.getElementById('loginTitle').textContent='Create your admin account';
      document.getElementById('loginDescription').textContent='Set up the first admin login for this Workwise server.';
      document.getElementById('loginSubmit').innerHTML='Create admin account <span>↗</span>';
      document.getElementById('setupHint').hidden=false;
      passwordInput.minLength=10;
      passwordInput.autocomplete='new-password';
      passwordInput.placeholder='At least 10 characters';
      if(setupKeyRequired){
        const keyLabel=document.createElement('label');
        keyLabel.htmlFor='adminSetupKey';
        keyLabel.textContent='Setup key';
        const keyInput=document.createElement('input');
        keyInput.type='password';keyInput.id='adminSetupKey';keyInput.autocomplete='off';keyInput.placeholder='Provided by the site administrator';keyInput.required=true;
        keyLabel.append(keyInput);
        loginForm.insertBefore(keyLabel,document.getElementById('loginError'));
      }
    }
  }catch{
    showLoginError('Can’t connect to the Workwise server. Start it, then refresh this page.');
    document.getElementById('loginSubmit').disabled=true;
  }
}

loginForm.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!loginForm.reportValidity())return;
  const button=document.getElementById('loginSubmit');
  button.disabled=true;
  showLoginError('');
  try{
    const response=await fetch(setupMode?'/api/admin/setup':'/api/auth/login',{
      method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email:emailInput.value.trim(),password:passwordInput.value,role:'admin',setupKey:document.getElementById('adminSetupKey')?.value})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Sign-in failed.');
    if(result.role!=='admin')throw new Error('This account does not have admin access.');
    localStorage.setItem('workwise-admin-auth','signed-in');
    window.location.replace('admin.html');
  }catch(error){showLoginError(error.message||'Sign-in failed.');button.disabled=false}
});

document.getElementById('togglePassword').addEventListener('click',event=>{
  const visible=passwordInput.type==='password';
  passwordInput.type=visible?'text':'password';
  event.currentTarget.textContent=visible?'Hide':'Show';
  event.currentTarget.setAttribute('aria-label',visible?'Hide password':'Show password');
});

function showLoginError(message){loginError.textContent=message;loginError.hidden=!message}
initializeAdminLogin();
