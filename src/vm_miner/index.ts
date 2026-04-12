import { internal_create_module, internal_get_cached_vm_handle, internal_initialise, randomx_init_cache, RxCache, type DatasetModule, type RxCacheHandle } from '../dataset/dataset';
import { bc, hex2bin, hex2target, sleep, type Config, type FromWorker, type Job, type MinerCallbacks, type NonceSpace, type ToWorker, type WorkerMessageInit, type WorkerMessageMine, type WorkerMessageNewCache, type WorkerPong } from './util';
import { jit_detect } from '../detect/detect';
import { nanoid } from 'nanoid';

// @ts-ignore
import worker_url from 'url:./vm'

// @ts-ignore
import dataset_wasm, { wasm_pages as dataset_wasm_pages } from 'dataset.wasm'

declare var ENVIRONMENT: 'node' | 'browser'
let WorkerCtor: any = globalThis.Worker
if (ENVIRONMENT !== 'browser') {
	WorkerCtor = require('worker_threads').Worker
}

const jit_feature = jit_detect()
const worker_ready = new Set<string>()

type MainState = {
	cache_memory: WebAssembly.Memory
	cache_exports: DatasetModule
	callbacks: MinerCallbacks

	// depends on the key K from current_job
	current_job?: {
		job: Job
		rx_cache: RxCache
	}

	workers: Map<string, { postMessage: (message: unknown) => void }>
}

function create_default_callbacks(): MinerCallbacks {
	let last_stats_time = Date.now()
	const stats = new Map<string, WorkerPong>()

	return {
		on_cache_initialising: () => {
			console.log('on_job: initialising a new cache')
		},
		on_cache_initialised: (duration_ms) => {
			console.log(`on_job: initialise cache: ${duration_ms}ms`)
		},
		on_worker_ready: () => {
			// no-op by default
		},
		on_job_started: (event) => {
			console.log(event.miner_id, `job ${event.job_id} nonce space [${event.nonce_start}, ${event.nonce_end}), target ${event.target}`)
		},
		on_job_disposed: (event) => {
			console.log(event.miner_id, 'disposing job')
		},
		on_nonce_space_exhausted: (event) => {
			console.log(event.miner_id, `job ${event.job_id} exhausted nonce space`)
		},
		on_result_found: (event) => {
			console.log(event.miner_id, `found after ${event.hash_count} hashes, nonce ${event.nonce} result ${event.result}`)
		},
		on_pong: (event) => {
			stats.set(event.miner_id, event)
			const now = Date.now()
			if (now - last_stats_time >= 1000) {
				last_stats_time = now

				const worker_count = stats.size
				const total_hashrate = Array.from(stats.values()).reduce((a, b) => a + b.stats.hashes_per_second, 0)
				const total_hashes = Array.from(stats.values()).reduce((a, b) => a + b.stats.hashes_total, 0)
				const avg_hashrate = total_hashrate / worker_count

				console.log(`Workers: ${worker_count} | Full Hashrate: ${total_hashrate.toLocaleString()} H/s | Average Worker Hashrate: ${avg_hashrate.toLocaleString()} H/s | Total Hashes: ${total_hashes.toLocaleString()}`)
			}
		},
	}
}

let active_callbacks: MinerCallbacks = create_default_callbacks()

async function main_new_state(config: Config): Promise<MainState> {
	const callbacks: MinerCallbacks = {
		...create_default_callbacks(),
		...(config.callbacks ?? {})
	}
	active_callbacks = callbacks

	const cache = new WebAssembly.Memory({
		initial: dataset_wasm_pages, maximum: dataset_wasm_pages, shared: true
	})

	if (!config.target_threads) {
		// TODO or some other method?
		if (ENVIRONMENT === 'browser') {
			config.target_threads = navigator.hardwareConcurrency ?? 4
		} else {
			// Node.js fallback
			config.target_threads = require('os').cpus().length ?? 4
		}
	}

	const workers = new Map<string, { postMessage: (message: unknown) => void }>()
	const vm = internal_get_cached_vm_handle()

	for (let i = 0; i < config.target_threads!!; i++) {
		const worker = ENVIRONMENT === 'browser'
			? new WorkerCtor(worker_url, { type: 'module' })
			: new WorkerCtor(worker_url)
		const miner_id = nanoid()
		worker_ready.delete(miner_id)

		worker.postMessage({
			type: 'init',

			miner_id,
			jit_feature,
			cache,
			vm,
		} satisfies WorkerMessageInit)

		workers.set(miner_id, worker)
	}

	await wait_for_workers_ready(workers, 5000)

	return {
		cache_memory: cache,
		cache_exports: internal_create_module(cache),
		callbacks,
		workers,
	}
}

async function wait_for_workers_ready(workers: Map<string, { postMessage: (message: unknown) => void }>, timeout_ms: number) {
	const deadline = Date.now() + timeout_ms
	while (true) {
		let all_ready = true
		for (const miner_id of workers.keys()) {
			if (!worker_ready.has(miner_id)) {
				all_ready = false
				break
			}
		}

		if (all_ready) {
			return
		}

		if (Date.now() >= deadline) {
			const missing = Array.from(workers.keys()).filter((id) => !worker_ready.has(id))
			throw new Error(`timed out waiting for workers to initialise: ${missing.join(', ')}`)
		}

		await sleep(10)
	}
}

function postToWorkers(st: MainState, message: ToWorker) {
	if (ENVIRONMENT === 'browser') {
		for (const worker of st.workers.values()) {
			worker.postMessage(message)
		}
	} else {
		bc.postMessage(message)
	}
}

function on_job(st: MainState, job: Job) {
	if (st.current_job?.job.seed_hash !== job.seed_hash) {
		const seed_hash = hex2bin(job.seed_hash)

		st.callbacks.on_cache_initialising()
		const init_start = Date.now()

		// existing 256 MiBs of cache is being reused here.
		// this will take a while to initialise the cache
		const rx_cache = internal_initialise(seed_hash, st.cache_memory, st.cache_exports)
		const init_duration = Date.now() - init_start
		st.callbacks.on_cache_initialised(init_duration)

		st.current_job = { job, rx_cache }

		const message_init: WorkerMessageNewCache = {
			type: 'init_cache',
			thunk: rx_cache.thunk,
		}

		// we are mining again, here is a new (cache, thunk) pair derived from K.
		// remember, thunk is the superscalar hash instance
		postToWorkers(st, message_init satisfies ToWorker)
	}

	const blob = hex2bin(job.blob)
	const target = hex2target(job.target)

	// we are not using individual Worker instances, all instances get the same
	// BroadcastChannel to use. this message goes out to all

	const work_allocation: Record<string, NonceSpace> = {}

	// avoid a race condition, make a copy
	const miners = Array.from(st.workers.keys())

	// distribute jobs to workers
	const nonce_space = Math.ceil(0xffffffff / miners.length)
	let nonce = 0
	for (const miner_id of miners) {
		let nonce_end = nonce + nonce_space

		work_allocation[miner_id] = {
			nonce_start: nonce,
			nonce_end: nonce_end <= 0xffffffff ? nonce_end : 0xffffffff,
		}

		nonce += nonce_space
	}

	const message_mine: WorkerMessageMine = {
		type: 'mine',

		job_id: st.current_job.job.job_id,
		blob,
		target,

		work_allocation,
	}

	postToWorkers(st, message_mine satisfies ToWorker)
}

bc.onmessage = ({ data }: MessageEvent<FromWorker>) => {
	if (data.type === 'event_worker_ready') {
		worker_ready.add(data.miner_id)
		active_callbacks.on_worker_ready(data)
	} else if (data.type === 'event_job_started') {
		active_callbacks.on_job_started(data)
    } else if (data.type === 'event_job_disposed') {
		active_callbacks.on_job_disposed(data)
    } else if (data.type === 'event_nonce_space_exhausted') {
		active_callbacks.on_nonce_space_exhausted(data)
    } else if (data.type === 'event_result_found') {
		active_callbacks.on_result_found(data)
    } else if (data.type === 'pong') {
		active_callbacks.on_pong(data)
    }
}

export async function mine(job: Job, config: Config = {}) {
	const st = await main_new_state(config)

	on_job(st, job)
}
