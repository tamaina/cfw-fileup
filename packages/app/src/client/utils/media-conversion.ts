import { checkImageDecodeSupport, getBrowserImageResizerSupportWithAvif, resizeAndConvertImage, type BrowserImageAnimationPolicy, type BrowserImageExifPolicy, type BrowserImageOutputMime } from '@browser-mc/browser-image-resizer-ex';
import {
	buildMovieConversionOptions,
	checkMovieVideoEncoderBitDepthSupport,
	convertMovieToHls,
	type BrowserMovieResizeOptions,
	type MovieHlsAsset,
} from '@browser-mc/browser-movie-converter';
import {
	ALL_FORMATS,
	type AudioCodec,
	BlobSource,
	BufferTarget,
	Conversion,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
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
export type MediaVideoRawBitDepth = 'preserve' | 8 | 10 | 12;
export type MediaVideoRawChromaSubsampling = 'preserve' | '420' | '422' | '444';
export type MediaImageAvifVariant = {
	chromaSubsampling: MediaImageAvifChromaSubsampling;
	bitDepth: MediaImageAvifBitDepth;
};
export const HLS_PLAYLIST_MIME = 'application/vnd.apple.mpegurl';
export const HLS_MASTER_PLAYLIST_NAME = 'master.m3u8';
export type MediaVideoOutputMime = 'video/mp4' | 'video/webm' | typeof HLS_PLAYLIST_MIME;
export type { AudioCodec, MovieHlsAsset, VideoCodec };

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

/** HLS の1バリアント（レンディション）分の設定 */
export interface MediaHlsVariantSettings {
	videoCodec: VideoCodec;
	videoBitrate: number;
	maxWidth: number | null;
	maxHeight: number | null;
	colorMetadata: MediaColorMetadataPolicy;
	rawBitDepth: MediaVideoRawBitDepth;
	rawChromaSubsampling: MediaVideoRawChromaSubsampling;
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
	rawBitDepth: MediaVideoRawBitDepth;
	rawChromaSubsampling: MediaVideoRawChromaSubsampling;
	/** HLS 出力時のバリアント一覧。HLS 以外の出力では使われない */
	hlsVariants: MediaHlsVariantSettings[];
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

export interface MediaVideoEncodeVariant {
	videoCodec: VideoCodec;
	bitDepth: Exclude<MediaVideoRawBitDepth, 'preserve'>;
	chromaSubsampling: Exclude<MediaVideoRawChromaSubsampling, 'preserve'>;
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
		rawBitDepth: 'preserve',
		rawChromaSubsampling: 'preserve',
		hlsVariants: [{
			videoCodec: 'avc',
			videoBitrate: 2_500_000,
			maxWidth: 1920,
			maxHeight: 1080,
			colorMetadata: 'preserve',
			rawBitDepth: 'preserve',
			rawChromaSubsampling: 'preserve',
		}],
	},
});

export const mediaVideoCodecOptions = {
	'video/mp4': ['avc', 'hevc', 'av1'] satisfies VideoCodec[],
	'video/webm': ['vp9', 'vp8', 'av1'] satisfies VideoCodec[],
	// HLS のセグメントはコーデックに応じて自動選択される（avc/hevc は MPEG-TS、av1/vp9 は CMAF）
	[HLS_PLAYLIST_MIME]: ['avc', 'hevc', 'av1', 'vp9'] satisfies VideoCodec[],
} as const satisfies Record<MediaVideoOutputMime, readonly VideoCodec[]>;

export const mediaAudioCodecOptions = {
	'video/mp4': ['aac', 'mp3'] satisfies AudioCodec[],
	'video/webm': ['opus', 'vorbis'] satisfies AudioCodec[],
	// opus は MPEG-TS に格納できないため、選ぶとセグメントは CMAF になる
	[HLS_PLAYLIST_MIME]: ['aac', 'mp3', 'opus'] satisfies AudioCodec[],
} as const satisfies Record<MediaVideoOutputMime, readonly AudioCodec[]>;

export function defaultVideoCodecForOutput(outputMime: MediaVideoOutputMime): VideoCodec {
	return outputMime === 'video/webm' ? 'vp9' : 'avc';
}

export function defaultAudioCodecForOutput(outputMime: MediaVideoOutputMime): AudioCodec {
	return outputMime === 'video/webm' ? 'opus' : 'aac';
}

export function isHlsVideoOutput(outputMime: MediaVideoOutputMime): boolean {
	return outputMime === HLS_PLAYLIST_MIME;
}

export function normalizeVideoConversionSettings(settings: MediaVideoConversionSettings): MediaVideoConversionSettings {
	const selectableVideoCodecs = mediaVideoCodecOptions[settings.outputMime] as readonly VideoCodec[];
	const videoCodec = selectableVideoCodecs.includes(settings.videoCodec)
		? settings.videoCodec
		: defaultVideoCodecForOutput(settings.outputMime);
	const audioCodec = (mediaAudioCodecOptions[settings.outputMime] as readonly AudioCodec[]).includes(settings.audioCodec)
		? settings.audioCodec
		: defaultAudioCodecForOutput(settings.outputMime);
	// 後方互換: バリアント未設定なら単一設定から1行生成する
	const baseVariants = (settings.hlsVariants ?? []).length > 0
		? settings.hlsVariants
		: [{
			videoCodec,
			videoBitrate: settings.videoBitrate,
			maxWidth: settings.maxWidth,
			maxHeight: settings.maxHeight,
			colorMetadata: settings.colorMetadata,
			rawBitDepth: settings.rawBitDepth,
			rawChromaSubsampling: settings.rawChromaSubsampling,
		}];
	const hlsVariants = baseVariants.map(variant => ({
		...variant,
		videoCodec: selectableVideoCodecs.includes(variant.videoCodec)
			? variant.videoCodec
			: defaultVideoCodecForOutput(settings.outputMime),
		colorMetadata: variant.colorMetadata ?? settings.colorMetadata ?? 'preserve',
		rawBitDepth: variant.rawBitDepth ?? settings.rawBitDepth ?? 'preserve',
		rawChromaSubsampling: variant.rawChromaSubsampling ?? settings.rawChromaSubsampling ?? 'preserve',
	}));
	return {
		...settings,
		videoCodec,
		audioCodec,
		rawBitDepth: settings.rawBitDepth ?? 'preserve',
		rawChromaSubsampling: settings.rawChromaSubsampling ?? 'preserve',
		hlsVariants,
	};
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
		video: {
			...settings.video,
			hlsVariants: (settings.video.hlsVariants ?? []).map(variant => ({ ...variant })),
		},
	};
}

let browserImageResizerSupportWithAvifPromise: Promise<BrowserImageResizerSupportWithAvif> | undefined;
let browserMediaVideoEncodeSupportPromise: Promise<MediaVideoEncodeVariant[]> | undefined;

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

export async function supportedVideoEncodeVariants(): Promise<MediaVideoEncodeVariant[]> {
	const promise = browserMediaVideoEncodeSupportPromise ??= checkMovieVideoEncoderBitDepthSupport().then(results => results
		.filter(result => result.supported && isSupportedMediaVideoRawChromaSubsampling(result.chromaSubsampling))
		.map(result => ({
			videoCodec: result.codec as VideoCodec,
			bitDepth: result.bitDepth,
			chromaSubsampling: result.chromaSubsampling as Exclude<MediaVideoRawChromaSubsampling, 'preserve'>,
		})));
	return await promise;
}

function isSupportedMediaVideoRawChromaSubsampling(chromaSubsampling: string): chromaSubsampling is Exclude<MediaVideoRawChromaSubsampling, 'preserve'> {
	return chromaSubsampling === '420' || chromaSubsampling === '422' || chromaSubsampling === '444';
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

async function resolveImageColorMetadataPolicy(settings: MediaImageConversionSettings): Promise<MediaColorMetadataPolicy> {
	const colorMetadata = settings.colorMetadata ?? 'preserve';
	if (colorMetadata !== 'preserve') return colorMetadata;
	const support = await getMemoizedBrowserImageResizerSupportWithAvif();
	if (support.imageDecoder) return 'preserve';
	console.warn('ImageDecoder is not available; falling back to Canvas SDR color handling for image conversion');
	return 'canvas-sdr';
}

export function mediaOutputExtension(mimeType: MediaImageOutputMime | MediaVideoOutputMime): string {
	if (mimeType === 'image/avif') return '.avif';
	if (mimeType === 'image/jpeg') return '.jpg';
	if (mimeType === 'image/webp') return '.webp';
	if (mimeType === 'video/webm') return '.webm';
	if (mimeType === HLS_PLAYLIST_MIME) return '.m3u8';
	return '.mp4';
}

export function replacePathExtension(path: string, mimeType: MediaImageOutputMime | MediaVideoOutputMime): string {
	const extension = mediaOutputExtension(mimeType);
	const dot = path.lastIndexOf('.');
	const slash = path.lastIndexOf('/');
	if (dot > slash) return `${path.slice(0, dot)}${extension}`;
	return `${path}${extension}`;
}

function videoResizeOptions(settings: Pick<MediaVideoConversionSettings, 'maxWidth' | 'maxHeight' | 'rawBitDepth' | 'rawChromaSubsampling'>): BrowserMovieResizeOptions | undefined {
	const rawBitDepth = settings.rawBitDepth ?? 'preserve';
	const rawChromaSubsampling = settings.rawChromaSubsampling ?? 'preserve';
	if (
		settings.maxWidth == null
		&& settings.maxHeight == null
		&& rawBitDepth === 'preserve'
		&& rawChromaSubsampling === 'preserve'
	) {
		return undefined;
	}
	return {
		width: settings.maxWidth ?? undefined,
		height: settings.maxHeight ?? undefined,
		fit: 'contain',
		rawBitDepth,
		rawChromaSubsampling,
	};
}

/**
 * 変換前にブラウザの WebCodecs 対応状況を確認・補正するためのヘルパー群。
 *
 * Firefox など一部のブラウザではソース動画のデコード（例: HEVC は OS 依存）や
 * 指定コーデックのエンコード（例: AAC）に対応していないことがある。そのまま
 * mediabunny に渡すとトラックが黙って破棄され、変換設定が無視されたように見える
 * 結果（音声のみの HLS など）や変換失敗になる。
 * https://github.com/tamaina/cfw-fileup/issues/126
 */
async function assertVideoSourceDecodable(input: Input): Promise<void> {
	const videoTrack = await input.getPrimaryVideoTrack();
	if (videoTrack && !(await videoTrack.canDecode())) {
		const codec = await videoTrack.getCodec();
		throw new Error(`このブラウザでは元動画の映像（${codec ?? '不明なコーデック'}）をデコードできないため、変換できません。`);
	}
}

async function resolveEncodableVideoCodec(
	preferred: VideoCodec,
	candidates: readonly VideoCodec[],
	maxWidth: number | null,
	maxHeight: number | null,
	bitrate: number,
): Promise<VideoCodec> {
	const ordered = [preferred, ...candidates.filter(codec => codec !== preferred)];
	const encodable = await getFirstEncodableVideoCodec(ordered, {
		width: maxWidth ?? 1920,
		height: maxHeight ?? 1080,
		bitrate,
	});
	if (!encodable) {
		throw new Error('このブラウザではいずれの動画コーデックでもエンコードできないため、変換できません。');
	}
	if (encodable !== preferred) {
		console.warn(`Video codec "${preferred}" cannot be encoded in this browser; falling back to "${encodable}"`);
	}
	return encodable;
}

async function resolveEncodableAudioCodec(
	input: Input,
	preferred: AudioCodec,
	candidates: readonly AudioCodec[],
	bitrate: number,
): Promise<AudioCodec> {
	const audioTrack = await input.getPrimaryAudioTrack();
	if (!audioTrack) return preferred;
	const ordered = [preferred, ...candidates.filter(codec => codec !== preferred)];
	const encodable = await getFirstEncodableAudioCodec(ordered, {
		numberOfChannels: await audioTrack.getNumberOfChannels(),
		sampleRate: await audioTrack.getSampleRate(),
		bitrate,
	});
	// どれもエンコードできない場合はそのまま渡し、mediabunny 側で音声トラックを破棄して映像のみで続行する
	if (!encodable) return preferred;
	if (encodable !== preferred) {
		console.warn(`Audio codec "${preferred}" cannot be encoded in this browser; falling back to "${encodable}"`);
	}
	return encodable;
}

/** HLS 変換の出力ディレクトリ（入力パスの拡張子を除いたもの） */
export function hlsOutputDirectory(path: string): string {
	const dot = path.lastIndexOf('.');
	const slash = path.lastIndexOf('/');
	return dot > slash ? path.slice(0, dot) : path;
}

/** HLS 変換時のマスタープレイリストのパス */
export function hlsMasterPlaylistPath(path: string): string {
	return `${hlsOutputDirectory(path)}/${HLS_MASTER_PLAYLIST_NAME}`;
}

/** HLS 変換結果を単体アップロード/保存するときの tar パス */
export function hlsTarArchivePath(path: string): string {
	return `${hlsOutputDirectory(path)}.tar`;
}

export async function convertImageFile(file: File, settings: MediaImageConversionSettings): Promise<File> {
	try {
		const outputMime = await resolveImageOutputMimeType(settings.outputMime);
		const animation = await resolveImageAnimationPolicy(file, settings);
		const colorMetadata = await resolveImageColorMetadataPolicy(settings);
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
			colorMetadata,
			rawBitDepth: settings.avifBitDepth,
			rawChromaSubsampling: settings.avifChromaSubsampling,
			avif: {
				alpha: 'keep',
				chromaSubsampling: settings.avifChromaSubsampling,
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

/**
 * 動画を HLS（master.m3u8 + メディアプレイリスト + セグメント）へ変換する。
 * セグメント形式はコーデックに応じて自動選択される（avc/hevc は MPEG-TS、av1/vp9/opus は CMAF）。
 * アセットはストリームとして順次 yield される。パスは master.m3u8 からの相対パス。
 */
export async function* convertVideoFileToHls(file: File, settings: MediaVideoConversionSettings, onProgress?: (progress: number) => void): AsyncGenerator<MovieHlsAsset> {
	const normalizedSettings = normalizeVideoConversionSettings({ ...settings, outputMime: HLS_PLAYLIST_MIME });
	try {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});
		await assertVideoSourceDecodable(input);
		const audioCodec = await resolveEncodableAudioCodec(
			input,
			normalizedSettings.audioCodec,
			mediaAudioCodecOptions[HLS_PLAYLIST_MIME],
			normalizedSettings.audioBitrate,
		);
		const variants = await Promise.all(normalizedSettings.hlsVariants.map(async variant => ({
			video: {
				codec: await resolveEncodableVideoCodec(
					variant.videoCodec,
					mediaVideoCodecOptions[HLS_PLAYLIST_MIME],
					variant.maxWidth,
					variant.maxHeight,
					variant.videoBitrate,
				),
				bitrate: variant.videoBitrate,
			},
			resize: videoResizeOptions({
				...normalizedSettings,
				maxWidth: variant.maxWidth,
				maxHeight: variant.maxHeight,
				rawBitDepth: variant.rawBitDepth,
				rawChromaSubsampling: variant.rawChromaSubsampling,
			}),
			colorMetadata: variant.colorMetadata,
		})));
		for await (const asset of convertMovieToHls({
			input,
			rootPath: HLS_MASTER_PLAYLIST_NAME,
			variants,
			audio: {
				codec: audioCodec,
				bitrate: normalizedSettings.audioBitrate,
			},
			colorMetadata: normalizedSettings.colorMetadata ?? 'preserve',
			forceTranscode: true,
			onProgress: progress => onProgress?.(progress),
		})) {
			yield asset;
		}
	} catch (error) {
		console.error('HLS encoding failed', {
			fileName: file.name,
			fileType: file.type,
			fileSize: file.size,
			settings: normalizedSettings,
			error,
		});
		throw error;
	}
}

export async function convertVideoFile(file: File, settings: MediaVideoConversionSettings, onProgress?: (progress: number) => void): Promise<File> {
	if (isHlsVideoOutput(settings.outputMime)) {
		throw new Error('HLS出力は convertVideoFileToHls を使用してください。');
	}
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
		await assertVideoSourceDecodable(input);
		const videoCodec = await resolveEncodableVideoCodec(
			normalizedSettings.videoCodec,
			mediaVideoCodecOptions[normalizedSettings.outputMime],
			normalizedSettings.maxWidth,
			normalizedSettings.maxHeight,
			normalizedSettings.videoBitrate,
		);
		const audioCodec = await resolveEncodableAudioCodec(
			input,
			normalizedSettings.audioCodec,
			mediaAudioCodecOptions[normalizedSettings.outputMime],
			normalizedSettings.audioBitrate,
		);
		const plan = await buildMovieConversionOptions({
			input,
			output,
			video: {
				codec: videoCodec,
				bitrate: normalizedSettings.videoBitrate,
			},
			audio: {
				codec: audioCodec,
				bitrate: normalizedSettings.audioBitrate,
			},
			resize: videoResizeOptions(normalizedSettings),
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
