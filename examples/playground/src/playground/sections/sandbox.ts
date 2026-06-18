import { registerSection } from '../registry'

registerSection({
	slug: 'sandbox',
	title: 'Sandbox (Code Execution)',
	html: `
  <p class="note">Runs commands in an isolated Docker container via @cloudflare/sandbox SDK.</p>
  <form onsubmit="api('POST','/sandbox/exec',{command:formVal('sb-cmd')});return false">
    <label>Command <input id="sb-cmd" value="node -e &quot;console.log('Hello from Sandbox!')&quot;" style="min-width:350px"></label>
    <button type="submit">Exec</button>
  </form>
  <form onsubmit="api('POST','/sandbox/write-and-run',{filename:formVal('sb-file'),code:formVal('sb-code')});return false">
    <label>Filename <input id="sb-file" value="script.js"></label>
    <label>Code <textarea id="sb-code">const os = require('os');
console.log(\`Node \${process.version} on \${os.platform()} \${os.arch()}\`);
console.log(\`2 + 2 = \${2 + 2}\`);
const fib = n => n <= 1 ? n : fib(n-1) + fib(n-2);
for (let i = 0; i < 8; i++) console.log(\`  fib(\${i}) = \${fib(i)}\`);</textarea></label>
    <button type="submit">Write &amp; Run</button>
  </form>
  <div class="links" style="margin-top:0.5rem">
    <a href="#" onclick="api('POST','/sandbox/exec',{command:'uname -a'});return false">uname -a</a>
    <a href="#" onclick="api('POST','/sandbox/exec',{command:'ls -la /workspace'});return false">ls /workspace</a>
    <a href="#" onclick="api('POST','/sandbox/exec',{command:'node -e &quot;console.log(JSON.stringify({node: process.version, arch: process.arch}))&quot;'});return false">Node version</a>
  </div>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/sandbox/exec' && method === 'POST') {
			const { getSandbox } = await import('@cloudflare/sandbox')
			const sandbox = getSandbox(env.SANDBOX, 'dev')
			const body = (await request.json()) as { command: string }
			const result = await sandbox.exec(body.command)
			return Response.json({
				success: result.success,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				command: result.command,
				duration: result.duration,
			})
		}
		if (path === '/sandbox/write-and-run' && method === 'POST') {
			const { getSandbox } = await import('@cloudflare/sandbox')
			const sandbox = getSandbox(env.SANDBOX, 'dev')
			const body = (await request.json()) as { filename: string; code: string }
			await sandbox.writeFile(`/workspace/${body.filename}`, body.code)
			const ext = body.filename.split('.').pop()
			const runner = ext === 'py' ? 'python3' : ext === 'js' ? 'node' : ext === 'ts' ? 'npx tsx' : 'bash'
			const result = await sandbox.exec(`${runner} /workspace/${body.filename}`)
			return Response.json({
				success: result.success,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				command: result.command,
				duration: result.duration,
			})
		}
		return null
	},
})
