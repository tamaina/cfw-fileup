import { processDownloadJob, type ProcessingJob } from './download-processing';
self.onmessage = async (event: MessageEvent<{ jobId: number; job: ProcessingJob }>) => {
	try {
		const result = await processDownloadJob(event.data.job);
		self.postMessage({ jobId: event.data.jobId, result }, [result.bytes.buffer]);
	} catch (error) {
		self.postMessage({ jobId: event.data.jobId, error: error instanceof Error ? error.message : String(error) });
	}
};
