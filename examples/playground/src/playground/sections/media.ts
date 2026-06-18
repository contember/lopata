import { registerSection } from '../registry'

registerSection({
	slug: 'media',
	title: 'Media Transformations',
	html: `
  <p class="note">Upload a video file and extract a frame, generate a spritesheet, resize, or extract audio. Requires ffmpeg installed locally.</p>
  <form onsubmit="mediaUpload(this);return false" enctype="multipart/form-data">
    <label>Video file <input type="file" id="media-file" accept="video/*"></label>
    <label>Mode
      <select id="media-mode">
        <option value="frame">Extract frame</option>
        <option value="spritesheet">Spritesheet</option>
        <option value="video">Resize video</option>
        <option value="audio">Extract audio</option>
      </select>
    </label>
    <label>Width <input id="media-w" value="320" type="number" style="width:70px"></label>
    <label>Height <input id="media-h" value="240" type="number" style="width:70px"></label>
    <label>Offset <input id="media-offset" value="1" style="width:50px"></label>
    <button type="submit">Transform</button>
  </form>
  <div id="media-result" style="margin-top:1rem"></div>
  <script>
  async function mediaUpload(form) {
    var file = document.getElementById('media-file').files[0];
    if (!file) { alert('Select a video file'); return; }
    var mode = document.getElementById('media-mode').value;
    var w = document.getElementById('media-w').value;
    var h = document.getElementById('media-h').value;
    var offset = document.getElementById('media-offset').value;
    var params = new URLSearchParams({mode: mode});
    if (w) params.set('width', w);
    if (h) params.set('height', h);
    if (offset) params.set('offset', offset);
    var el = document.getElementById('media-result');
    el.textContent = 'Processing...';
    try {
      var res = await fetch('/media?' + params, { method: 'POST', body: file });
      if (!res.ok) { el.textContent = res.status + ': ' + await res.text(); return; }
      var ct = res.headers.get('content-type') || '';
      var blob = await res.blob();
      var u = URL.createObjectURL(blob);
      if (ct.startsWith('image/')) {
        el.innerHTML = '<img src="'+u+'" style="max-width:100%;border-radius:4px">';
      } else if (ct.startsWith('video/')) {
        el.innerHTML = '<video src="'+u+'" controls style="max-width:100%;border-radius:4px"></video>';
      } else if (ct.startsWith('audio/')) {
        el.innerHTML = '<audio src="'+u+'" controls></audio>';
      } else {
        el.textContent = 'Done (' + blob.size + ' bytes, ' + ct + ')';
      }
    } catch(e) { el.textContent = 'Error: ' + e.message; }
  }
  </script>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/media' && method === 'POST') {
			const mode = (url.searchParams.get('mode') ?? 'frame') as 'video' | 'frame' | 'spritesheet' | 'audio'
			const width = url.searchParams.get('width') ? parseInt(url.searchParams.get('width')!) : undefined
			const height = url.searchParams.get('height') ? parseInt(url.searchParams.get('height')!) : undefined
			const offset = url.searchParams.get('offset') ?? undefined

			let transformer = env.MEDIA.input(request.body!)
			if (width || height) {
				transformer = transformer.transform({ width, height })
			}
			return transformer.output({ mode, offset }).response()
		}
		return null
	},
})
