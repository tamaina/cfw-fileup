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
	const stream = new TransformStream<Uint8Array, Uint8Array>();
	const frame = document.createElement('iframe');
	frame.hidden = true;
	const cleanup = (failed: boolean) => {
		if (failed) channel.port1.postMessage('cancel');
		channel.port1.close();
		// 成功時は iframe を残す。削除するとブラウザ側の保存を中断する場合がある。
		if (failed) frame.remove();
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
				if (data?.type !== 'ready' || typeof data.path !== 'string' || !/^\/__stream-download\/[a-f0-9-]+$/.test(data.path)) return;
				clearTimeout(timer);
				frame.src = data.path;
				document.body.append(frame);
				resolve();
			};
			try {
				controller.postMessage({ type: 'stream-download-v1', stream: stream.readable, filename }, [stream.readable, channel.port2]);
			} catch (error) {
				clearTimeout(timer);
				reject(error);
			}
		});
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
