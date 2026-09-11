const active = new Map<WritableStream<Uint8Array>, (failed: boolean) => void>();

function pageHide(): void {
	for (const cleanup of active.values()) cleanup(true);
}

function beforeUnload(event: BeforeUnloadEvent): void {
	if (!active.size) return;
	event.preventDefault();
	event.returnValue = '';
}

/** SW が受信できた場合だけストリーム保存を選ぶ。旧 SW・非対応環境は従来保存へ戻す。 */
export async function createStreamDownload(filename: string): Promise<WritableStream<Uint8Array> | null> {
	const controller = navigator.serviceWorker?.controller;
	if (!controller) return null;
	try {
		const probe = new WritableStream();
		void structuredClone(probe, { transfer: [probe] }).abort();
	} catch {
		return null;
	}
	const channel = new MessageChannel();
	let registered = false;
	let outputController: TransformStreamDefaultController<Uint8Array>;
	const stream = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) { outputController = controller; },
	});
	const frame = document.createElement('iframe');
	frame.hidden = true;
	let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
	const cleanup = (failed: boolean) => {
		clearInterval(keepAliveTimer);
		if (failed) {
			// Writable 側は Worker に転送済みでも、生成元の controller から中止できる。
			// SW の制御ポートに依存せず、ブラウザと生成 Worker の両方に失敗を伝える。
			outputController.error(new Error('Download failed'));
			channel.port1.postMessage('cancel');
		} else {
			channel.port1.postMessage('complete');
		}
		if (!registered) channel.port1.close();
		// iframe は失敗時も残す。削除するとブラウザが終端・エラーを受け取る前に
		// ナビゲーションが切断され、保存の終了通知が失われる場合がある。
		active.delete(stream.writable);
		if (!active.size) {
			window.removeEventListener('beforeunload', beforeUnload);
			window.removeEventListener('pagehide', pageHide);
		}
	};
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Stream download SW did not respond')), 3000);
			channel.port1.onmessage = ({ data }) => {
				if (data?.type === 'finished') {
					channel.port1.close();
					return;
				}
				if (data?.type !== 'ready' || typeof data.path !== 'string' || !/^\/__stream-download\/[a-f0-9-]+$/.test(data.path)) return;
				clearTimeout(timer);
				registered = true;
				frame.src = data.path;
				document.body.append(frame);
				resolve();
			};
			try {
				controller.postMessage({ type: 'stream-download-v2', stream: stream.readable, filename }, [stream.readable, channel.port2]);
			} catch (error) {
				clearTimeout(timer);
				reject(error);
			}
		});
		// waitUntil だけでも Firefox の extended idle timeout に達するため、
		// 保存中に限って新しいイベントを届ける。終了後に SW を起こし続けない。
		keepAliveTimer = setInterval(() => {
			controller.postMessage({ type: 'stream-download-keepalive-v2' });
		}, 10_000);
		active.set(stream.writable, cleanup);
		window.addEventListener('beforeunload', beforeUnload);
		window.addEventListener('pagehide', pageHide);
		return stream.writable;
	} catch {
		cleanup(true);
		void stream.writable.abort().catch(() => {});
		return null;
	}
}

export function finishStreamDownload(stream?: WritableStream<Uint8Array>, failed = false): void {
	if (stream) active.get(stream)?.(failed);
}
