const http = require('http')
const path = require('path')
const fs = require('fs')

const server = http.createServer((request, response) => {
	switch (request.url) {
	case '/':
	case '/index.html':
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf8',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		})
		response.write(fs.readFileSync(path.resolve(__dirname, 'actual_mining_index.html')))
		break
	case '/lib.js':
		let libPath = path.resolve(__dirname, '../pkg-randomx.js-shared/dist/web/index.js')

		response.writeHead(200, {
			'Content-Type': 'application/javascript; charset=utf8',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		})
		response.write(fs.readFileSync(libPath))
		break
	default:
		response.writeHead(404, {
			'Content-Type': 'text/plain; charset=utf8'
		})
		response.write('404 Not Found')
		break
	}
	response.end()
})

server.listen(8080)

console.log('🌐 Actual Mining Server')
console.log('📍 http://localhost:8080/')
console.log('')
console.log('This example uses the actual RandomX mining implementation.')
console.log('Start the mining job from the web UI.')
