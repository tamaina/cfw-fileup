import { checkImageDecodeSupport, getBrowserImageResizerSupportWithAvif, resizeAndConvertImage, type BrowserImageAnimationPolicy, type BrowserImageExifPolicy, type BrowserImageOutputMime } from '@browser-mc/browser-image-resizer-ex';
import { buildMovieConversionOptions } from '@browser-mc/browser-movie-converter';
import {
	ALL_FORMATS,
	type AudioCodec,
	BlobSource,
	BufferTarget,
	Conversion,
	Input,
	Mp4OutputFormat,
	Output,
	type VideoCodec,
	WebMOutputFormat,
} from 'mediabunny';

type BrowserImageResizerSupportWithAvif = Awaited<ReturnType<typeof getBrowserImageResizerSupportWithAvif>>;

export type MediaImageOutputMime = BrowserImageOutputMime;
export type MediaImageAvifBitDepth = 8 | 10;
export type MediaImageAvifChromaSubsampling = '444' | '420';
export type MediaColorMetadataPolicy = 'preserve' | 'canvas-sdr';
export type MediaImageAvifVariant = {
	chromaSubsampling: MediaImageAvifChromaSubsampling;
	bitDepth: MediaImageAvifBitDepth;
};
export type MediaVideoOutputMime = 'video/mp4' | 'video/webm';
export type { AudioCodec, VideoCodec };

export interface MediaImageConversionSettings {
	enabled: boolean;
	outputMime: MediaImageOutputMime;
	quality: number;
	maxWidth: number;
	maxHeight: number;
	exif: BrowserImageExifPolicy;
	animation: BrowserImageAnimationPolicy;
	colorMetadata: MediaColorMetadataPolicy;
	avifBitDepth: MediaImageAvifBitDepth;
	avifChromaSubsampling: MediaImageAvifChromaSubsampling;
}

export interface MediaVideoConversionSettings {
	enabled: boolean;
	outputMime: MediaVideoOutputMime;
	videoCodec: VideoCodec;
	audioCodec: AudioCodec;
	videoBitrate: number;
	audioBitrate: number;
	maxWidth: number | null;
	maxHeight: number | null;
	colorMetadata: MediaColorMetadataPolicy;
}

export interface MediaConversionSettings {
	image: MediaImageConversionSettings;
	video: MediaVideoConversionSettings;
}

export interface BrowserMediaImageEncodeSupport {
	canEncodeWebp: boolean;
	canEncodeAvif: boolean;
	avifVariants: MediaImageAvifVariant[];
}

export const defaultMediaConversionSettings = (): MediaConversionSettings => ({
	image: {
		enabled: false,
		outputMime: 'image/webp',
		quality: 0.7,
		maxWidth: 1920,
		maxHeight: 1920,
		exif: 'drop-gps',
		animation: 'preserve',
		colorMetadata: 'preserve',
		avifBitDepth: 8,
		avifChromaSubsampling: '444',
	},
	video: {
		enabled: false,
		outputMime: 'video/mp4',
		videoCodec: 'avc',
		audioCodec: 'aac',
		videoBitrate: 2_500_000,
		audioBitrate: 128_000,
		maxWidth: 1920,
		maxHeight: 1080,
		colorMetadata: 'preserve',
	},
});

export const mediaVideoCodecOptions = {
	'video/mp4': ['avc', 'hevc', 'av1'] satisfies VideoCodec[],
	'video/webm': ['vp9', 'vp8', 'av1'] satisfies VideoCodec[],
} as const satisfies Record<MediaVideoOutputMime, readonly VideoCodec[]>;

export const mediaAudioCodecOptions = {
	'video/mp4': ['aac', 'mp3'] satisfies AudioCodec[],
	'video/webm': ['opus', 'vorbis'] satisfies AudioCodec[],
} as const satisfies Record<MediaVideoOutputMime, readonly AudioCodec[]>;

export function defaultVideoCodecForOutput(outputMime: MediaVideoOutputMime): VideoCodec {
	return outputMime === 'video/webm' ? 'vp9' : 'avc';
}

export function defaultAudioCodecForOutput(outputMime: MediaVideoOutputMime): AudioCodec {
	return outputMime === 'video/webm' ? 'opus' : 'aac';
}

export function normalizeVideoConversionSettings(settings: MediaVideoConversionSettings): MediaVideoConversionSettings {
	const videoCodec = (mediaVideoCodecOptions[settings.outputMime] as readonly VideoCodec[]).includes(settings.videoCodec)
		? settings.videoCodec
		: defaultVideoCodecForOutput(settings.outputMime);
	const audioCodec = (mediaAudioCodecOptions[settings.outputMime] as readonly AudioCodec[]).includes(settings.audioCodec)
		? settings.audioCodec
		: defaultAudioCodecForOutput(settings.outputMime);
	return { ...settings, videoCodec, audioCodec };
}

export function formatMbps(bitsPerSecond: number): string {
	return `${(bitsPerSecond / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} Mbps`;
}

export function formatKbps(bitsPerSecond: number): string {
	return `${Math.round(bitsPerSecond / 1_000).toLocaleString()} Kbps`;
}

export function cloneMediaConversionSettings(settings: MediaConversionSettings): MediaConversionSettings {
	return {
		image: { ...settings.image },
		video: { ...settings.video },
	};
}

let browserImageResizerSupportWithAvifPromise: Promise<BrowserImageResizerSupportWithAvif> | undefined;

async function getMemoizedBrowserImageResizerSupportWithAvif(): Promise<BrowserImageResizerSupportWithAvif> {
	browserImageResizerSupportWithAvifPromise ??= getBrowserImageResizerSupportWithAvif();
	return await browserImageResizerSupportWithAvifPromise;
}

export async function canEncodeImageMimeType(mimeType: MediaImageOutputMime): Promise<boolean> {
	const support = await getMemoizedBrowserImageResizerSupportWithAvif();
	if (mimeType === 'image/avif') return (await supportedAvifVariants()).length > 0;
	if (mimeType === 'image/jpeg') return true;
	return support.imageEncoder.webp;
}

export async function supportedAvifVariants(): Promise<MediaImageAvifVariant[]> {
	const support = await getMemoizedBrowserImageResizerSupportWithAvif();
	return [
		...(support.imageEncoder.avif.variants.yuv444.bit8 ? [{ chromaSubsampling: '444', bitDepth: 8 }] as const : []),
		...(support.imageEncoder.avif.variants.yuv444.bit10 ? [{ chromaSubsampling: '444', bitDepth: 10 }] as const : []),
		...(support.imageEncoder.avif.variants.yuv420.bit8 ? [{ chromaSubsampling: '420', bitDepth: 8 }] as const : []),
		...(support.imageEncoder.avif.variants.yuv420.bit10 ? [{ chromaSubsampling: '420', bitDepth: 10 }] as const : []),
	];
}

export async function getBrowserMediaImageEncodeSupport(): Promise<BrowserMediaImageEncodeSupport> {
	const support = await getMemoizedBrowserImageResizerSupportWithAvif();
	const avifVariants = await supportedAvifVariants();
	return {
		canEncodeWebp: support.imageEncoder.webp,
		canEncodeAvif: avifVariants.length > 0,
		avifVariants,
	};
}

export async function normalizeMediaImageConversionSettingsForBrowserSupport(settings: MediaImageConversionSettings): Promise<{
	settings: MediaImageConversionSettings;
	support: BrowserMediaImageEncodeSupport;
}> {
	const support = await getBrowserMediaImageEncodeSupport();
	let imageSettings = settings;
	if (!support.canEncodeWebp && imageSettings.outputMime === 'image/webp') {
		imageSettings = { ...imageSettings, outputMime: 'image/jpeg' };
	}
	const selectedAvifVariant = support.avifVariants.find(variant =>
		variant.bitDepth === imageSettings.avifBitDepth
		&& variant.chromaSubsampling === imageSettings.avifChromaSubsampling
	);
	const fallbackAvifVariant = support.avifVariants[0];
	if (!selectedAvifVariant && fallbackAvifVariant) {
		imageSettings = {
			...imageSettings,
			avifBitDepth: fallbackAvifVariant.bitDepth,
			avifChromaSubsampling: fallbackAvifVariant.chromaSubsampling,
		};
	}
	return { settings: imageSettings, support };
}

export async function resolveImageOutputMimeType(mimeType: MediaImageOutputMime): Promise<MediaImageOutputMime> {
	return await canEncodeImageMimeType(mimeType) ? mimeType : 'image/jpeg';
}

async function resolveImageAnimationPolicy(file: File, settings: MediaImageConversionSettings): Promise<BrowserImageAnimationPolicy> {
	if (settings.animation !== 'preserve') return settings.animation;
	const preserveSupport = await checkImageDecodeSupport(file, file.type, {
		animation: 'preserve',
		colorSpaceConversion: 'none',
	});
	if (preserveSupport.supported) return 'preserve';
	const firstFrameSupport = await checkImageDecodeSupport(file, file.type, {
		animation: 'first-frame',
		colorSpaceConversion: 'none',
	});
	if (!firstFrameSupport.supported) return 'preserve';
	console.warn('Image animation metadata could not be read; falling back to first-frame conversion', {
		fileName: file.name,
		fileType: file.type,
		fileSize: file.size,
		preserveError: preserveSupport.error,
	});
	return 'first-frame';
}

export function mediaOutputExtension(mimeType: MediaImageOutputMime | MediaVideoOutputMime): string {
	if (mimeType === 'image/avif') return '.avif';
	if (mimeType === 'image/jpeg') return '.jpg';
	if (mimeType === 'image/webp') return '.webp';
	if (mimeType === 'video/webm') return '.webm';
	return '.mp4';
}

export function replacePathExtension(path: string, mimeType: MediaImageOutputMime | MediaVideoOutputMime): string {
	const extension = mediaOutputExtension(mimeType);
	const dot = path.lastIndexOf('.');
	const slash = path.lastIndexOf('/');
	if (dot > slash) return `${path.slice(0, dot)}${extension}`;
	return `${path}${extension}`;
}

function avifCodecForVariant(chromaSubsampling: MediaImageAvifChromaSubsampling, bitDepth: MediaImageAvifBitDepth): string {
	const profile = chromaSubsampling === '444' ? 1 : 0;
	return `av01.${profile}.08M.${String(bitDepth).padStart(2, '0')}`;
}

export async function convertImageFile(file: File, settings: MediaImageConversionSettings): Promise<File> {
	try {
		const outputMime = await resolveImageOutputMimeType(settings.outputMime);
		const animation = await resolveImageAnimationPolicy(file, settings);
		const result = await resizeAndConvertImage({
			input: file,
			inputMime: file.type,
			outputMime,
			width: settings.maxWidth,
			height: settings.maxHeight,
			fit: 'contain',
			quality: settings.quality,
			exif: settings.exif,
			animation,
			colorMetadata: settings.colorMetadata ?? 'preserve',
			rawBitDepth: settings.avifBitDepth,
			rawChromaSubsampling: settings.avifChromaSubsampling,
			avif: {
				alpha: 'keep',
				chromaSubsampling: settings.avifChromaSubsampling,
				codec: avifCodecForVariant(settings.avifChromaSubsampling, settings.avifBitDepth),
			},
		});
		const name = replacePathExtension(file.name, result.mime);
		return new File([result.blob], name, { type: result.mime, lastModified: file.lastModified });
	} catch (error) {
		console.error('Image encoding failed', {
			fileName: file.name,
			fileType: file.type,
			fileSize: file.size,
			settings,
			error,
		});
		throw error;
	}
}

export async function convertVideoFile(file: File, settings: MediaVideoConversionSettings, onProgress?: (progress: number) => void): Promise<File> {
	const normalizedSettings = normalizeVideoConversionSettings(settings);
	try {
		const target = new BufferTarget();
		const output = new Output({
			target,
			format: normalizedSettings.outputMime === 'video/webm'
				? new WebMOutputFormat()
				: new Mp4OutputFormat({ fastStart: 'in-memory' }),
		});
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});
		const plan = await buildMovieConversionOptions({
			input,
			output,
			video: {
				codec: normalizedSettings.videoCodec,
				bitrate: normalizedSettings.videoBitrate,
			},
			audio: {
				codec: normalizedSettings.audioCodec,
				bitrate: normalizedSettings.audioBitrate,
			},
			resize: normalizedSettings.maxWidth != null || normalizedSettings.maxHeight != null
				? {
					width: normalizedSettings.maxWidth ?? undefined,
					height: normalizedSettings.maxHeight ?? undefined,
					fit: 'contain',
				}
				: undefined,
			forceTranscode: true,
			colorMetadata: normalizedSettings.colorMetadata ?? 'preserve',
		});
		const conversion = await Conversion.init(plan.options);
		conversion.onProgress = progress => onProgress?.(progress);
		if (!conversion.isValid) {
			throw new Error('この動画は現在のブラウザでは変換できません。');
		}
		await conversion.execute();
		if (!target.buffer) throw new Error('動画変換の出力を作成できませんでした。');
		const name = replacePathExtension(file.name, normalizedSettings.outputMime);
		return new File([target.buffer], name, { type: normalizedSettings.outputMime, lastModified: file.lastModified });
	} catch (error) {
		console.error('Video encoding failed', {
			fileName: file.name,
			fileType: file.type,
			fileSize: file.size,
			settings: normalizedSettings,
			error,
		});
		throw error;
	}
}
