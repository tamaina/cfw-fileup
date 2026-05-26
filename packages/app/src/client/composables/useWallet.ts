import { computed, ref } from 'vue';
import {
	ChainNotConfiguredError,
	useChainId,
	useConnection,
	useConnect,
	useConnectors,
	useSendTransaction,
	useSignMessage,
	useSwitchChain,
	useWaitForTransactionReceipt,
} from '@wagmi/vue';
import { getAddress, toHex, type Address, type Hex, type TransactionReceipt } from 'viem';

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

type WalletChainConfig = {
	chainId: number;
	name: string;
	nativeCurrencyName: string;
	nativeCurrencySymbol: string;
	nativeCurrencyDecimals: number;
	rpcUrls: string[];
	blockExplorerUrl: string | null;
};

type WalletTokenConfig = {
	address: Address;
	symbol: string;
	decimals: number;
	image?: string;
};

type WalletProvider = {
	request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
};

function chainIdHex(chainId: number): `0x${string}` {
	return `0x${chainId.toString(16)}`;
}

function getErrorCode(error: unknown): number | string | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const maybeError = error as { code?: unknown };
	return typeof maybeError.code === 'number' || typeof maybeError.code === 'string' ? maybeError.code : undefined;
}

function isChainNotConfiguredError(error: unknown): boolean {
	return error instanceof ChainNotConfiguredError;
}

function parseHexQuantity(value: unknown): bigint | null {
	if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
	return BigInt(value);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function useWallet() {
	const { address, chainId: accountChainId } = useConnection();
	const currentChainId = useChainId();
	const connectors = useConnectors();
	const { mutateAsync: connectMutationAsync } = useConnect();
	const { mutateAsync: signMessageMutationAsync } = useSignMessage();
	const { mutateAsync: switchChainMutationAsync } = useSwitchChain();
	const { mutateAsync: sendTransactionMutationAsync } = useSendTransaction();

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

		const result = await connectMutationAsync({ connector });
		const connectedAddress = result.accounts[0];
		if (!connectedAddress) throw new Error('ウォレット接続に失敗しました');

		return {
			address: connectedAddress,
			chainId: result.chainId,
		};
	}

	async function switchWalletChain(chainId: number): Promise<void> {
		if (accountChainId.value === chainId) return;
		await switchChainMutationAsync({ chainId } as Parameters<typeof switchChainMutationAsync>[0]);
	}

	async function switchOrAddWalletChain(chain: WalletChainConfig): Promise<void> {
		if (accountChainId.value === chain.chainId) return;
		try {
			await switchWalletChain(chain.chainId);
			return;
		} catch (error) {
			if (!isChainNotConfiguredError(error)) throw error;
		}

		const connector = connectors.value[0];
		const provider = await connector?.getProvider?.() as WalletProvider | undefined;
		if (!provider) throw new Error('Ethereum wallet が見つかりません');
		const chainId = chainIdHex(chain.chainId);

		try {
			await provider.request({
				method: 'wallet_switchEthereumChain',
				params: [{ chainId }],
			});
			return;
		} catch (error) {
			if (getErrorCode(error) !== 4902) throw error;
		}

		await provider.request({
			method: 'wallet_addEthereumChain',
			params: [{
				chainId,
				chainName: chain.name,
				nativeCurrency: {
					name: chain.nativeCurrencyName,
					symbol: chain.nativeCurrencySymbol,
					decimals: chain.nativeCurrencyDecimals,
				},
				rpcUrls: chain.rpcUrls,
				blockExplorerUrls: chain.blockExplorerUrl ? [chain.blockExplorerUrl] : undefined,
			}],
		});
	}

	async function signWalletMessage(message: string): Promise<Hex> {
		try {
			return await signMessageMutationAsync({ message });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (!errorMessage.includes('ConnectorChainMismatchError')) throw error;
			if (!address.value) throw error;
			const connector = connectors.value[0];
			const provider = await connector?.getProvider?.() as WalletProvider | undefined;
			if (!provider) throw error;
			return await provider.request({
				method: 'personal_sign',
				params: [message, address.value],
			}) as Hex;
		}
	}

	async function watchWalletAsset(token: WalletTokenConfig): Promise<boolean> {
		const connector = connectors.value[0];
		const provider = await connector?.getProvider?.() as WalletProvider | undefined;
		if (!provider) throw new Error('Ethereum wallet が見つかりません');
		const options: Record<string, unknown> = {
			address: getAddress(token.address),
			symbol: token.symbol.slice(0, 11),
			decimals: token.decimals,
		};
		if (token.image) options.image = token.image;
		const result = await provider.request({
			method: 'wallet_watchAsset',
			params: {
				type: 'ERC20',
				options,
			},
		});
		return result === true;
	}

	async function sendWalletTransaction(params: {
		account: Address;
		chainId: number;
		data: Hex;
		to: Address;
		value?: bigint;
	}): Promise<Hex> {
		try {
			return await sendTransactionMutationAsync({
				chainId: params.chainId,
				data: params.data,
				to: params.to,
				value: params.value ?? 0n,
			} as Parameters<typeof sendTransactionMutationAsync>[0]);
		} catch (error) {
			if (!isChainNotConfiguredError(error)) throw error;
		}

		const connector = connectors.value[0];
		const provider = await connector?.getProvider?.() as WalletProvider | undefined;
		if (!provider) throw new Error('Ethereum wallet が見つかりません');
		const txHash = await provider.request({
			method: 'eth_sendTransaction',
			params: [{
				from: params.account,
				to: params.to,
				data: params.data,
				value: toHex(params.value ?? 0n),
			}],
		});
		if (typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error('txHash の取得に失敗しました');
		return txHash as Hex;
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

		try {
			const result = await receiptQuery.refetch({ throwOnError: true });
			if (!result.data) throw new Error('送金トランザクションの確認に失敗しました');
			return result.data as TransactionReceipt;
		} catch (error) {
			if (!isChainNotConfiguredError(error)) throw error;
		}

		const connector = connectors.value[0];
		const provider = await connector?.getProvider?.() as WalletProvider | undefined;
		if (!provider) throw new Error('Ethereum wallet が見つかりません');
		const startedAt = Date.now();
		const timeout = options.timeout ?? 120_000;
		const pollingInterval = options.pollingInterval ?? 4_000;
		const confirmations = Math.max(1, options.confirmations ?? 1);

		while (timeout === 0 || Date.now() - startedAt <= timeout) {
			const receipt = await provider.request({
				method: 'eth_getTransactionReceipt',
				params: [hash],
			}) as { blockNumber?: unknown } | null;
			const receiptBlockNumber = parseHexQuantity(receipt?.blockNumber);
			if (receipt && receiptBlockNumber !== null) {
				if (confirmations <= 1) return receipt as TransactionReceipt;
				const blockNumberRaw = await provider.request({ method: 'eth_blockNumber' });
				const blockNumber = parseHexQuantity(blockNumberRaw);
				if (blockNumber !== null && blockNumber >= receiptBlockNumber && blockNumber - receiptBlockNumber + 1n >= BigInt(confirmations)) {
					return receipt as TransactionReceipt;
				}
			}
			await sleep(pollingInterval);
		}
		throw new Error('送金トランザクションの確認がタイムアウトしました');
	}

	return {
		currentChainId,
		walletAddress,
		walletChainId,
		connectWallet,
		switchWalletChain,
		switchOrAddWalletChain,
		signWalletMessage,
		watchWalletAsset,
		sendWalletTransaction,
		waitForWalletTransactionReceipt,
	};
}
