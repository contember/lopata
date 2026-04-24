import type { R2Object } from '../bindings/r2'

export function escapeXML(str: string): string {
	return str.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)
}

const ERROR_STATUS = {
	NoSuchBucket: 404,
	NoSuchKey: 404,
	NoSuchUpload: 404,
	AccessDenied: 403,
	PreconditionFailed: 412,
	NotModified: 304,
	InvalidArgument: 400,
	InvalidRequest: 400,
	InvalidRange: 416,
	InvalidPart: 400,
	MalformedXML: 400,
	BadDigest: 400,
	InternalError: 500,
} as const

export type S3ErrorCode = keyof typeof ERROR_STATUS

export function statusForError(code: S3ErrorCode): number {
	return ERROR_STATUS[code]
}

export function xmlResponse(body: string, status: number, extra?: Headers): Response {
	const headers = new Headers({ 'content-type': 'application/xml' })
	if (extra) { for (const [k, v] of extra) headers.set(k, v) }
	return new Response(body, { status, headers })
}

export function xmlError(code: S3ErrorCode, message: string, resource = '', extra?: Headers): Response {
	const body = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${escapeXML(code)}</Code>
  <Message>${escapeXML(message)}</Message>
  <Resource>${escapeXML(resource)}</Resource>
  <RequestId>0000000000000000</RequestId>
</Error>`
	return xmlResponse(body, statusForError(code), extra)
}

export interface ListV2Params {
	prefix?: string
	continuationToken?: string
	startAfter?: string
	maxKeys?: number
	delimiter?: string
}

export interface ListV1Params {
	prefix?: string
	marker?: string
	maxKeys?: number
	delimiter?: string
}

function renderContents(items: R2Object[]): string {
	return items
		.map(
			(o) =>
				`  <Contents>
    <Key>${escapeXML(o.key)}</Key>
    <LastModified>${o.uploaded.toISOString()}</LastModified>
    <ETag>"${o.etag}"</ETag>
    <Size>${o.size}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`,
		)
		.join('\n')
}

function renderCommonPrefixes(delimitedPrefixes: string[]): string {
	return delimitedPrefixes
		.map((p) => `  <CommonPrefixes><Prefix>${escapeXML(p)}</Prefix></CommonPrefixes>`)
		.join('\n')
}

export function listBucketV2Xml(
	bucket: string,
	params: ListV2Params,
	items: R2Object[],
	truncated: boolean,
	nextContinuation: string | undefined,
	delimitedPrefixes: string[],
): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXML(bucket)}</Name>
  <Prefix>${escapeXML(params.prefix ?? '')}</Prefix>
  ${params.delimiter ? `<Delimiter>${escapeXML(params.delimiter)}</Delimiter>` : ''}
  <KeyCount>${items.length + delimitedPrefixes.length}</KeyCount>
  <MaxKeys>${params.maxKeys ?? 1000}</MaxKeys>
  <IsTruncated>${truncated ? 'true' : 'false'}</IsTruncated>
  ${nextContinuation ? `<NextContinuationToken>${escapeXML(nextContinuation)}</NextContinuationToken>` : ''}
${renderContents(items)}
${renderCommonPrefixes(delimitedPrefixes)}
</ListBucketResult>`
}

export function listBucketV1Xml(
	bucket: string,
	params: ListV1Params,
	items: R2Object[],
	truncated: boolean,
	nextMarker: string | undefined,
	delimitedPrefixes: string[],
): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXML(bucket)}</Name>
  <Prefix>${escapeXML(params.prefix ?? '')}</Prefix>
  ${params.marker ? `<Marker>${escapeXML(params.marker)}</Marker>` : '<Marker/>'}
  ${params.delimiter ? `<Delimiter>${escapeXML(params.delimiter)}</Delimiter>` : ''}
  <MaxKeys>${params.maxKeys ?? 1000}</MaxKeys>
  <IsTruncated>${truncated ? 'true' : 'false'}</IsTruncated>
  ${nextMarker ? `<NextMarker>${escapeXML(nextMarker)}</NextMarker>` : ''}
${renderContents(items)}
${renderCommonPrefixes(delimitedPrefixes)}
</ListBucketResult>`
}

export function getBucketLocationXml(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">auto</LocationConstraint>`
}

export function initiateMultipartUploadXml(bucket: string, key: string, uploadId: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXML(bucket)}</Bucket>
  <Key>${escapeXML(key)}</Key>
  <UploadId>${escapeXML(uploadId)}</UploadId>
</InitiateMultipartUploadResult>`
}

export function completeMultipartUploadXml(bucket: string, key: string, etag: string, location: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>${escapeXML(location)}</Location>
  <Bucket>${escapeXML(bucket)}</Bucket>
  <Key>${escapeXML(key)}</Key>
  <ETag>"${escapeXML(etag)}"</ETag>
</CompleteMultipartUploadResult>`
}

export function copyObjectResultXml(etag: string, lastModified: Date): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <LastModified>${lastModified.toISOString()}</LastModified>
  <ETag>"${escapeXML(etag)}"</ETag>
</CopyObjectResult>`
}

export interface DeleteResultEntry {
	key: string
	error?: { code: string; message: string }
}

export function deleteResultXml(entries: DeleteResultEntry[], quiet: boolean): string {
	const parts = entries
		.map((e) => {
			if (e.error) {
				return `  <Error>
    <Key>${escapeXML(e.key)}</Key>
    <Code>${escapeXML(e.error.code)}</Code>
    <Message>${escapeXML(e.error.message)}</Message>
  </Error>`
			}
			if (quiet) return ''
			return `  <Deleted>
    <Key>${escapeXML(e.key)}</Key>
  </Deleted>`
		})
		.filter((s) => s !== '')
		.join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
${parts}
</DeleteResult>`
}

export function listMultipartUploadsXml(
	bucket: string,
	uploads: Array<{ key: string; uploadId: string; initiated: Date }>,
): string {
	const items = uploads
		.map(
			(u) =>
				`  <Upload>
    <Key>${escapeXML(u.key)}</Key>
    <UploadId>${escapeXML(u.uploadId)}</UploadId>
    <Initiated>${u.initiated.toISOString()}</Initiated>
    <StorageClass>STANDARD</StorageClass>
  </Upload>`,
		)
		.join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXML(bucket)}</Bucket>
  <IsTruncated>false</IsTruncated>
${items}
</ListMultipartUploadsResult>`
}

export function listPartsXml(
	bucket: string,
	key: string,
	uploadId: string,
	parts: Array<{ partNumber: number; etag: string; size: number; lastModified: Date }>,
): string {
	const items = parts
		.map(
			(p) =>
				`  <Part>
    <PartNumber>${p.partNumber}</PartNumber>
    <LastModified>${p.lastModified.toISOString()}</LastModified>
    <ETag>"${escapeXML(p.etag)}"</ETag>
    <Size>${p.size}</Size>
  </Part>`,
		)
		.join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXML(bucket)}</Bucket>
  <Key>${escapeXML(key)}</Key>
  <UploadId>${escapeXML(uploadId)}</UploadId>
  <StorageClass>STANDARD</StorageClass>
  <IsTruncated>false</IsTruncated>
${items}
</ListPartsResult>`
}

/**
 * Parse a CompleteMultipartUpload request body.
 * Expected: <CompleteMultipartUpload><Part><PartNumber>N</PartNumber><ETag>"x"</ETag></Part>...</CompleteMultipartUpload>
 */
export function parseCompletePartsXml(body: string): Array<{ partNumber: number; etag: string }> {
	const parts: Array<{ partNumber: number; etag: string }> = []
	const partBlocks = body.match(/<Part>[\s\S]*?<\/Part>/g) ?? []
	for (const block of partBlocks) {
		const pn = block.match(/<PartNumber>\s*(\d+)\s*<\/PartNumber>/)
		const et = block.match(/<ETag>\s*([\s\S]*?)\s*<\/ETag>/)
		if (!pn || !et) continue
		const etag = et[1]!.trim().replace(/^"+|"+$/g, '').replace(/^&quot;+|&quot;+$/g, '')
		parts.push({ partNumber: Number(pn[1]), etag })
	}
	return parts
}

/**
 * Parse a DeleteObjects request body.
 * Expected: <Delete><Object><Key>k</Key></Object>...<Quiet>true</Quiet>?</Delete>
 */
export function parseDeleteRequestXml(body: string): { keys: string[]; quiet: boolean } {
	const keys: string[] = []
	const re = /<Object>\s*<Key>([^<]+)<\/Key>(?:\s*<VersionId>[^<]*<\/VersionId>)?\s*<\/Object>/g
	let m: RegExpExecArray | null
	while ((m = re.exec(body)) !== null) {
		keys.push(decodeXmlEntities(m[1]!))
	}
	const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(body)
	return { keys, quiet }
}

function decodeXmlEntities(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&')
}
