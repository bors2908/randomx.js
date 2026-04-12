/**
 * Wrapper to make mining compatible with browser execution
 * Acts as a bridge between browser and the mining implementation
 */

import { mine as libMine } from './lib.js'

// Expose for global access
window.miningReady = false

// Check which format we got
const isESM = typeof libMine === 'function'

if (!isESM) {
	console.error('ERROR: Failed to load mining library as ESM. The build may not be complete.')
	console.error('Run: bun scripts/build.ts')
} else {
	window.miningReady = true
	console.log('✅ Mining library loaded successfully')
}

// Export for ES module import
export { libMine as mine }
