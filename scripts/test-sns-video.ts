import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  downloadSnsVideoToFile,
  isPlayableVideoBuffer
} from '../electron/services/snsVideoUtils.ts'

const mp4Fixture = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftyp'),
  Buffer.from('isom'),
  Buffer.alloc(12)
])

assert.equal(isPlayableVideoBuffer(mp4Fixture), true, 'MP4 ftyp header should be accepted')
assert.equal(isPlayableVideoBuffer(Buffer.from('<html>CDN error</html>')), false, 'HTML error body must not be cached as video')
assert.equal(isPlayableVideoBuffer(Buffer.alloc(0)), false, 'empty downloads must be rejected')

const tempDir = await mkdtemp(join(tmpdir(), 'ciphertalk-sns-video-test-'))
const outputPath = join(tempDir, 'redirected.mp4')

const server = createServer((request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(302, { Location: '/video?from=redirect' })
    response.end()
    return
  }

  if (request.url === '/video?from=redirect') {
    response.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(mp4Fixture.length)
    })
    response.end(mp4Fixture)
    return
  }

  response.writeHead(404)
  response.end()
})

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const result = await downloadSnsVideoToFile(
    `http://127.0.0.1:${address.port}/redirect`,
    outputPath,
    { timeoutMs: 2_000 }
  )

  assert.deepEqual(result, { success: true }, 'HTTP and relative CDN redirects should be followed')
  assert.deepEqual(await readFile(outputPath), mp4Fixture, 'redirected video bytes should be written intact')

  const invalidProtocol = await downloadSnsVideoToFile('ftp://example.test/video.mp4', join(tempDir, 'invalid.mp4'))
  assert.equal(invalidProtocol.success, false, 'unsupported protocols should fail without writing a cache file')
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(tempDir, { recursive: true, force: true })
}

console.log('sns video tests passed')
