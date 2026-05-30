import { ref } from 'vue';
import type { Ref } from 'vue';

export function useBackupCodeActions(
	backupCodes: Ref<string[]>,
	formatBackupCode: (code: string) => string,
	onError?: (message: string) => void,
) {
	const copied = ref(false);

	async function copyBackupCodes(): Promise<void> {
		try {
			await navigator.clipboard.writeText(backupCodes.value.map(formatBackupCode).join('\n'));
		} catch {
			onError?.('コピーに失敗しました');
			return;
		}
		copied.value = true;
		setTimeout(() => { copied.value = false; }, 2000);
	}

	function downloadBackupCodes(): void {
		const date = new Date().toLocaleDateString('ja-JP');
		const header = `# cfw-fileup バックアップコード\n# 生成日: ${date}\n#\n# 各コードは一度しか使用できません。\n# 安全な場所に保管してください。\n\n`;
		const body = backupCodes.value.map(formatBackupCode).join('\n');
		const blob = new Blob([header + body], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'cfw-fileup-backup-codes.txt';
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 100);
	}

	return { copied, copyBackupCodes, downloadBackupCodes };
}
