import { computed, ref } from 'vue';
import {
	useAccount,
	useChainId,
	useConnect,
	useConnectors,
	useSendTransaction,
	useSignMessage,
	useSwitchChain,
	useWaitForTransactionReceipt,
} from '@wagmi/vue';
import type { Address, Hex, TransactionReceipt } from 'viem';

type ConnectedWallet = {
	address: Address;
	chainId: number;
};

type WaitForWalletTransactionReceiptOptions = {
	chainId: number;
	confirmations?: number;
	pollingInterval?: number;
	timeout?: number;
};

export function useWallet() {
	const { address, chainId: accountChainId } = useAccount();
	const currentChainId = useChainId();
	const connectors = useConnectors();
	const { connectAsync } = useConnect();
	const { signMessageAsync } = useSignMessage();
	const { switchChainAsync } = useSwitchChain();
	const { sendTransactionAsync } = useSendTransaction();

	const receiptHash = ref<Hex>();
	const receiptChainId = ref<number>();
	const receiptConfirmations = ref(1);
	const receiptPollingInterval = ref<number>();
	const receiptTimeout = ref<number>();
	const receiptQuery = useWaitForTransactionReceipt({
		hash: receiptHash,
		chainId: receiptChainId,
		confirmations: receiptConfirmations,
		pollingInterval: receiptPollingInterval,
		timeout: receiptTimeout,
		query: {
			enabled: false,
			retry: false,
		},
	} as Parameters<typeof useWaitForTransactionReceipt>[0]);

	const walletAddress = computed(() => address.value);
	const walletChainId = computed(() => accountChainId.value);

	async function connectWallet(): Promise<ConnectedWallet> {
		if (address.value && accountChainId.value) {
			return { address: address.value, chainId: accountChainId.value };
		}

		const connector = connectors.value[0];
		if (!connector) throw new Error('Ethereum wallet が見つかりません');

		const result = await connectAsync({ connector });
		const connectedAddress = result.accounts[0];
		if (!connectedAddress) throw new Error('ウォレット接続に失敗しました');

		return {
			address: connectedAddress,
			chainId: result.chainId,
		};
	}

	async function switchWalletChain(chainId: number): Promise<void> {
		if (accountChainId.value === chainId) return;
		await switchChainAsync({ chainId } as Parameters<typeof switchChainAsync>[0]);
	}

	async function signWalletMessage(message: string): Promise<Hex> {
		return await signMessageAsync({ message });
	}

	async function sendWalletTransaction(params: {
		account: Address;
		chainId: number;
		data: Hex;
		to: Address;
		value?: bigint;
	}): Promise<Hex> {
		return await sendTransactionAsync({
			account: params.account,
			chainId: params.chainId,
			data: params.data,
			to: params.to,
			value: params.value ?? 0n,
		} as Parameters<typeof sendTransactionAsync>[0]);
	}

	async function waitForWalletTransactionReceipt(
		hash: Hex,
		options: WaitForWalletTransactionReceiptOptions,
	): Promise<TransactionReceipt> {
		receiptHash.value = hash;
		receiptChainId.value = options.chainId;
		receiptConfirmations.value = Math.max(1, options.confirmations ?? 1);
		receiptPollingInterval.value = options.pollingInterval;
		receiptTimeout.value = options.timeout;

		const result = await receiptQuery.refetch({ throwOnError: true });
		if (!result.data) throw new Error('送金トランザクションの確認に失敗しました');
		return result.data as TransactionReceipt;
	}

	return {
		currentChainId,
		walletAddress,
		walletChainId,
		connectWallet,
		switchWalletChain,
		signWalletMessage,
		sendWalletTransaction,
		waitForWalletTransactionReceipt,
	};
}
