import { generate } from '@pdfme/generator';
import { text } from '@pdfme/schemas';
import { BLANK_PDF } from '@pdfme/common';
import { formatUnits } from 'viem';
import type { RefundView } from '../../shared/api/refunds';

/** Snapshot evidence refers to the original orders; it never overwrites them. */
export async function downloadRefundPdf(view: RefundView): Promise<void> {
	const { request, transfers } = view;
	if (request.status !== 'completed' || !request.quote || !request.seller || request.completedAt === null) throw new Error('返金証憑は返金確定後に取得できます。');
	const lines = [
		'返金証憑', `申請ID: ${request.id}`, `返金確定: ${new Date(request.completedAt).toISOString()}`,
		`終了希望: ${new Date(request.requestedCutoffAt).toISOString()}`, `適用終了: ${new Date(request.quote.effectiveCutoffAt).toISOString()}`,
		`日時調整理由: ${request.adjustmentReason || '-'}`,
		`販売者: ${request.seller.name}`, `住所: ${request.seller.address}`, `登録番号: ${request.seller.invoiceRegistrationNumber}`, '',
	];
	for (const group of request.quote.groups) {
		lines.push(`返金額: ${formatUnits(BigInt(group.amountBaseUnits), group.decimals)} ${group.tokenSymbol} / ${group.chainName}`,
			`返金先: ${group.payerAddress}`, `トークン契約: ${group.contractAddress}`,
			`Tx Hash: ${transfers.find(transfer => transfer.id === group.id)?.txHash ?? '-'}`);
		for (const line of group.lines) lines.push(`原注文: ${line.sourceOrder.id} / 割当: ${line.assignmentId}`,
			`返金明細: ${formatUnits(BigInt(line.amountBaseUnits), group.decimals)} ${group.tokenSymbol}`,
			`税: ${line.taxName} ${line.taxRate} / 税額 ${formatUnits(BigInt(line.taxAmountBaseUnits), group.decimals)} ${line.taxCurrency}`);
		lines.push('');
	}
	const chunks: string[] = [];
	for (let index = 0; index < lines.length; index += 26) chunks.push(lines.slice(index, index + 26).join('\n'));
	const fontName = 'IBMPlexSansJP';
	const fontResponse = await fetch('/assets/fonts/ibm_plex_sans_jp/IBMPlexSansJP-Regular.ttf');
	if (!fontResponse.ok) throw new Error('返金証憑の日本語フォントを取得できません。');
	const fontData = await fontResponse.arrayBuffer();
	const schema = { name: 'body', type: 'text', fontName, position: { x: 15, y: 15 }, width: 180, height: 265, fontSize: 9, lineHeight: 1.4 };
	const pdf = await generate({ template: { basePdf: BLANK_PDF, schemas: chunks.map((_, index) => [{ ...schema, name: `body${index}` }]) },
																														inputs: [Object.fromEntries(chunks.map((chunk, index) => [`body${index}`, chunk]))],
		plugins: { text }, options: { font: { [fontName]: { data: fontData, fallback: true } } } });
	const url = URL.createObjectURL(new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }));
	const a = document.createElement('a'); a.href = url; a.download = `refund-${request.id}.pdf`; a.click();
	URL.revokeObjectURL(url);
}
