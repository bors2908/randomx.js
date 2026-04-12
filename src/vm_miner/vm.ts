import { type RxCacheHandle } from '../dataset/dataset'
import type { JitFeature } from '../detect/detect'
import { bc, type FromWorker, type ToWorker, type WorkerMessageInit, type WorkerMessageMine, type WorkerMessageResult } from './util'

// @ts-ignore
import { wasm_pages } from 'vm.wasm'

type RxSuperscalarHash = (item_index: bigint) => [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]

type VmModule = {
	i(feature: JitFeature): number // returns scratch buffer
	B(blob_length: number, target: bigint, nonce: number, nonce_end: number): number // begin mining
	Rm(): number // iterate virtual machine
	n(): bigint // get nonce
	h(): number // get number of hashes
}

let vm_exports!: VmModule
let vm_memory!: WebAssembly.Memory

let cache!: WebAssembly.Memory
let jit_imports!: { e: { m: WebAssembly.Memory, d: RxSuperscalarHash } }
let cache_ready = false

let scratch!: Uint8Array
let miner_id!: string

// if job == null, then not mining
let job: WorkerMessageMine | null = null
let job_mining_began: number = 0

function schedule_iterate() {
	if (ENVIRONMENT === 'browser') {
		setTimeout(iterate, 0)
	} else {
		setImmediate(iterate)
	}
}

function iterate() {
	// job is always true here
	if (!job) {
		return
	}
	
	outer: for (var iter = 0; iter < 512; iter++) {
		const jit_size = vm_exports.Rm()

		switch (jit_size) {
			case 0:
			// exhausted nonce space
			bc.postMessage({
				type: 'event_nonce_space_exhausted',
				miner_id,
				job_id: job.job_id,
			} satisfies FromWorker)
			job = null
			break outer
		case 1:
			const result: WorkerMessageResult = {
				type: 'result',
				miner_id,

				job_id: job.job_id,
				nonce: Number(vm_exports.n()),
				result: scratch.slice(0, 32), // R = Hash256()
			}

            const hash_count = vm_exports.h()
			bc.postMessage({
				type: 'event_result_found',
				miner_id,
				job_id: job.job_id,
				hash_count: hash_count,
				nonce: result.nonce,
				result: result.result,
			} satisfies FromWorker)

			bc.postMessage(result satisfies FromWorker)
			job = null
			break outer
		}

		// iterate virtual machine
		const jit_wm = new WebAssembly.Module(scratch.subarray(0, jit_size) as any)
		const jit_wi = new WebAssembly.Instance(jit_wm, jit_imports)
		const jit_exports = jit_wi.exports as { d: () => void }
		jit_exports.d()
	}

	// send pong
	const h = vm_exports.h()
	bc.postMessage({
		type: 'pong',
		miner_id,

		stats: {
			hashes_per_second: Math.floor((h * 1000) / (Date.now() - job_mining_began)),
			hashes_total: Number(h),
		}
	} satisfies FromWorker)

	if (job) {
		schedule_iterate()
	}
}

function hasType(data: unknown): data is { type: string } {
	return !!data && typeof data === 'object' && 'type' in data && typeof (data as { type: unknown }).type === 'string'
}

function asInboundMessage(data: unknown): ToWorker | WorkerMessageResult | null {
	if (!hasType(data)) {
		return null
	}

	switch (data.type) {
		case 'dispose':
			return data as ToWorker
		case 'init_cache':
			return data as ToWorker
		case 'mine':
			if (
				typeof (data as { job_id?: unknown }).job_id === 'string' &&
				(data as { blob?: unknown }).blob instanceof Uint8Array &&
				typeof (data as { target?: unknown }).target === 'bigint' &&
				typeof (data as { work_allocation?: unknown }).work_allocation === 'object' &&
				(data as { work_allocation?: unknown }).work_allocation !== null
			) {
				return data as ToWorker
			}
			return null
		case 'result':
			if (
				typeof (data as { miner_id?: unknown }).miner_id === 'string' &&
				typeof (data as { job_id?: unknown }).job_id === 'string' &&
				typeof (data as { nonce?: unknown }).nonce === 'number' &&
				(data as { result?: unknown }).result instanceof Uint8Array
			) {
				return data as WorkerMessageResult
			}
			return null
		default:
			return null
	}
}

function message(data: unknown) {
	const typed = asInboundMessage(data)
	if (!typed) {
		return
	}

	// someone else got to it before us
	if (typed.type === 'result') {
		job = null
	}
	
	if (typed.type === 'init_cache') {
		const ssh = new WebAssembly.Instance(typed.thunk, {
			e: {
				m: cache
			}
		})
		jit_imports = {
			e: {
				m: vm_memory,
				d: ssh.exports.d as RxSuperscalarHash,
			}
		}
		cache_ready = true
		if (job) {
			schedule_iterate()
		}
	} else if (typed.type === 'dispose') {
		bc.postMessage({
			type: 'event_job_disposed',
			miner_id,
		} satisfies FromWorker)
		job = null
	} else if (typed.type === 'mine') {
		const was_mining = !!job

		job_mining_began = Date.now()
		job = typed
		const nonce_space = job.work_allocation[miner_id]
		if (!nonce_space) {
			bc.postMessage({
				type: 'event_job_disposed',
				miner_id,
			} satisfies FromWorker)
			job = null
			return
		}

		// begin mining, reinitialise everything
        bc.postMessage({
			type: 'event_job_started',
			miner_id,
			job_id: job.job_id,
			nonce_start: nonce_space.nonce_start,
			nonce_end: nonce_space.nonce_end,
			target: job.target,
		} satisfies FromWorker)
		scratch.set(job.blob)
		vm_exports.B(job.blob.length, job.target, nonce_space.nonce_start, nonce_space.nonce_end)

		if (!was_mining && cache_ready) {
			schedule_iterate()
		}
	}
}

function init(e: WorkerMessageInit) {
	miner_id = e.miner_id
	cache = e.cache
	cache_ready = false

	vm_memory = new WebAssembly.Memory({ initial: wasm_pages, maximum: wasm_pages })
	const wi_imports: Record<string, Record<string, WebAssembly.ImportValue>> = {
		env: {
			memory: vm_memory
		}
	}
	
	const vm = new WebAssembly.Instance(e.vm, wi_imports)
	vm_exports = vm.exports as VmModule

	const scratch_ptr = vm_exports.i(e.jit_feature)
	scratch = new Uint8Array(vm_memory.buffer, scratch_ptr, 16 * 1024)

	bc.onmessage = (e) => message(e.data)

	// In browsers, runtime control messages (mine/init_cache/dispose) are
	// delivered from the main thread over worker.postMessage.
	if (ENVIRONMENT === 'browser') {
		onmessage = (e) => message(e.data)
	}

	bc.postMessage({
		type: 'event_worker_ready',
		miner_id,
	} satisfies FromWorker)
}

declare var ENVIRONMENT: 'node' | 'browser'

if (ENVIRONMENT === 'node') {
	// not supported at the moment

	const { parentPort } = await import('worker_threads')
	var postMessage = parentPort!.postMessage.bind(parentPort!)
	parentPort!.on('message', init)
} else {
	onmessage = (e) => init(e.data)
}
