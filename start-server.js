const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const host = '127.0.0.1';
const port = Number(process.env.PORT) || 8000;
const url = `http://${host}:${port}/index.html`;

function isRunning() {
  return new Promise(resolve => {
    const request = http.get(url, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(700, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

(async () => {
  if (await isRunning()) {
    console.log(`Workwise is already running at http://${host}:${port}`);
    return;
  }

  const serverPath = path.join(__dirname, 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (await isRunning()) {
      console.log(`Workwise is ready at http://${host}:${port}`);
      return;
    }
  }

  console.error('Workwise did not start. Check whether port 8000 is available.');
  process.exitCode = 1;
})();
