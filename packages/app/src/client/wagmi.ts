import { createConfig, http, injected } from '@wagmi/vue';
import { arbitrum, base, mainnet, optimism, polygon } from '@wagmi/vue/chains';

export const wagmiConfig = createConfig({
	chains: [mainnet, base, polygon, arbitrum, optimism],
	connectors: [injected()],
	transports: {
		[mainnet.id]: http(),
		[base.id]: http(),
		[polygon.id]: http(),
		[arbitrum.id]: http(),
		[optimism.id]: http(),
	},
});
