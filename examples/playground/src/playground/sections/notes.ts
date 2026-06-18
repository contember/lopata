import { registerSection } from '../registry'

registerSection({
	slug: 'notes',
	title: 'SQL Notes (DO with SQLite)',
	html: `
  <div class="links">
    <a href="#" onclick="api('GET','/notes/my-notebook');return false">LIST notes</a>
  </div>
  <form onsubmit="api('POST','/notes/'+formVal('notes-ns'),{title:formVal('note-title'),body:formVal('note-body')});return false">
    <label>Notebook <input id="notes-ns" value="my-notebook"></label>
    <label>Title <input id="note-title" value="Hello"></label>
    <label>Body <textarea id="note-body">First note using DO SQLite!</textarea></label>
    <button type="submit">Create note</button>
  </form>
  <form onsubmit="api('GET','/notes/'+formVal('notes-ns2')+'/'+formVal('note-get-id'));return false">
    <label>Notebook <input id="notes-ns2" value="my-notebook"></label>
    <label>ID <input id="note-get-id" value="1" type="number"></label>
    <button type="submit" class="secondary">GET by ID</button>
  </form>
  <form onsubmit="api('DELETE','/notes/'+formVal('notes-ns3')+'/'+formVal('note-del-id'));return false">
    <label>Notebook <input id="notes-ns3" value="my-notebook"></label>
    <label>ID <input id="note-del-id" value="1" type="number"></label>
    <button type="submit" class="danger">DELETE</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method
		const notesMatch = path.match(/^\/notes\/([^/]+)(\/(\d+))?$/)
		if (!notesMatch) return null

		const name = decodeURIComponent(notesMatch[1]!)
		const noteId = notesMatch[3] ? parseInt(notesMatch[3]) : null
		const id = env.SQL_NOTES.idFromName(name)
		const stub = env.SQL_NOTES.get(id)

		if (!noteId && method === 'GET') {
			const notes = await stub.list()
			return Response.json({ notebook: name, notes })
		}
		if (!noteId && method === 'POST') {
			const body = (await request.json()) as { title: string; body?: string }
			const note = await stub.create(body.title, body.body ?? '')
			return Response.json(note, { status: 201 })
		}
		if (noteId && method === 'GET') {
			const note = await stub.get(noteId)
			return Response.json(note)
		}
		if (noteId && method === 'DELETE') {
			await stub.remove(noteId)
			return Response.json({ deleted: noteId })
		}
		return null
	},
})
