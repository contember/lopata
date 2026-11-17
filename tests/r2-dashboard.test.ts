import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The dashboard handlers use the process-wide database under `<cwd>/.lopata`, so they run in a child process.
const SRC = resolve(import.meta.dir, '../src')

test('the dashboard and the binding read and write the same objects', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'r2-dashboard-'))
	try {
		const script = `
import { handleR2Download, handleR2Upload } from ${JSON.stringify(join(SRC, 'api/r2.ts'))}
import { handlers } from ${JSON.stringify(join(SRC, 'api/handlers/r2.ts'))}
import { FileR2Bucket } from ${JSON.stringify(join(SRC, 'bindings/r2.ts'))}
import { getDatabase, getDataDir } from ${JSON.stringify(join(SRC, 'db.ts'))}
const form = new FormData()
form.set('bucket', 'files')
form.set('key', 'docs/readme.txt')
form.set('file', new File(['hello'], 'readme.txt'))
const upload = await handleR2Upload(new Request('http://x/__api/r2/upload', { method: 'POST', body: form }))
const download = async key => {
	const response = await handleR2Download(new URL('http://x/__api/r2/download?bucket=files&key=' + encodeURIComponent(key)))
	return [response.status, response.status === 200 ? await response.text() : null, response.headers.get('content-type')]
}
const uploaded = await download('docs/readme.txt')
const binding = new FileR2Bucket(getDatabase(), 'files', getDataDir())
const readByBinding = await (await binding.get('docs/readme.txt')).text()
await binding.put('from-binding', 'stored by the binding', { httpMetadata: { contentType: 'application/x-test' } })
const fromBinding = await download('from-binding')
await handlers['r2.renameObject']({ bucket: 'files', oldKey: 'from-binding', newKey: 'renamed-binding' })
const renamedBinding = await (await binding.get('renamed-binding')).text()
await handlers['r2.deleteObject']({ bucket: 'files', key: 'renamed-binding' })
await handlers['r2.renameObject']({ bucket: 'files', oldKey: 'docs/readme.txt', newKey: 'docs/renamed.txt' })
const afterRename = [await download('docs/readme.txt'), await download('docs/renamed.txt')]
await handlers['r2.deleteObject']({ bucket: 'files', key: 'docs/renamed.txt' })
const afterDelete = await download('docs/renamed.txt')
const listed = handlers['r2.listObjects']({ bucket: 'files' }).items.map(o => o.key)
console.log(JSON.stringify({ upload: upload.status, uploaded, readByBinding, fromBinding, renamedBinding, afterRename, afterDelete, listed }))
`
		const child = Bun.spawn([process.execPath, '--eval', script], { cwd: directory, stdout: 'pipe', stderr: 'pipe' })
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
		expect(JSON.parse(stdout)).toEqual({
			upload: 200,
			uploaded: [200, 'hello', 'text/plain;charset=utf-8'],
			readByBinding: 'hello',
			fromBinding: [200, 'stored by the binding', 'application/x-test'],
			renamedBinding: 'stored by the binding',
			afterRename: [[404, null, null], [200, 'hello', 'text/plain;charset=utf-8']],
			afterDelete: [404, null, null],
			listed: [],
		})
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
