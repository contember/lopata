import { registerSection } from '../registry'

registerSection({
	slug: 'email',
	title: 'Email (Send + Incoming Trigger)',
	html: `
  <p class="note">
    Outbound mail is recorded in lopata's <code>email_messages</code> table.
    Inspect everything at <a href="/__dashboard/#/email" target="_blank">/__dashboard/#/email ↗</a>.
  </p>

  <h4 style="color:#fb923c;margin:0.75rem 0 0.4rem 0;font-size:0.95rem">Outbound — env.MAILER.send()</h4>
  <form onsubmit="api('POST','/email/send',{from:formVal('mail-from'),to:formVal('mail-to'),subject:formVal('mail-subject'),body:formVal('mail-body')});return false">
    <label>From <input id="mail-from" value="sender@example.com" style="min-width:220px"></label>
    <label>To <input id="mail-to" value="recipient@example.com" style="min-width:220px"></label>
    <label>Subject <input id="mail-subject" value="Hello from playground" style="min-width:260px"></label>
    <label>Body <textarea id="mail-body">This is a test message sent via env.MAILER.send().</textarea></label>
    <button type="submit">Send via MAILER</button>
  </form>

  <h4 style="color:#fb923c;margin:1.25rem 0 0.4rem 0;font-size:0.95rem">Incoming — trigger worker's email() handler</h4>
  <div class="links">
    <a href="#" onclick="document.getElementById('in-to').value='forward@example.com';return false">Preset: forward@</a>
    <a href="#" onclick="document.getElementById('in-to').value='reject@example.com';return false">Preset: reject@</a>
    <a href="#" onclick="document.getElementById('in-to').value='hello@example.com';return false">Preset: auto-reply</a>
  </div>
  <form onsubmit="(function(){var qs='from='+encodeURIComponent(formVal('in-from'))+'&to='+encodeURIComponent(formVal('in-to'));var raw='From: '+formVal('in-from')+'\\r\\nTo: '+formVal('in-to')+'\\r\\nSubject: '+formVal('in-subject')+'\\r\\n\\r\\n'+formVal('in-body');api('POST','/cdn-cgi/handler/email?'+qs,raw);})();return false">
    <label>From <input id="in-from" value="customer@example.com" style="min-width:220px"></label>
    <label>To <input id="in-to" value="hello@example.com" style="min-width:220px"></label>
    <label>Subject <input id="in-subject" value="Question about your service" style="min-width:260px"></label>
    <label>Body <textarea id="in-body">Hi! I have a question.</textarea></label>
    <button type="submit">Trigger email() handler</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/email/send' && method === 'POST') {
			const { from, to, subject, body } = await request.json() as {
				from: string
				to: string
				subject: string
				body: string
			}
			if (!from || !to) {
				return Response.json({ sent: false, error: 'from and to are required' }, { status: 400 })
			}
			const raw = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject ?? ''}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${
				body ?? ''
			}`
			const { EmailMessage } = await import('cloudflare:email')
			try {
				await env.MAILER.send(new EmailMessage(from, to, raw))
				return Response.json({
					sent: true,
					from,
					to,
					subject,
					bytes: raw.length,
					note: 'Saved to lopata email_messages table — view at /__dashboard/#/email',
				})
			} catch (err) {
				return Response.json({ sent: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
			}
		}

		return null
	},
})
