import NodeCache from "node-cache";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
    createNft,
    fetchDigitalAsset,
    mplTokenMetadata,
    updateV1,
    findMetadataPda,
    verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
    generateSigner,
    keypairIdentity,
    percentAmount,
    publicKey,
    TransactionBuilder,
    Umi,
    sol,
} from "@metaplex-foundation/umi";
import { getExplorerLink } from "@solana-developers/helpers";
import { transferSol } from "@metaplex-foundation/mpl-toolbox";
import bs58 from "bs58";
import { elizaLogger } from "@ai16z/eliza";

async function sleep(ms: number = 3000) {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, ms);
    });
}

export class WalletSolana {
    private cache: NodeCache;
    private umi: Umi;

    constructor(
        private connection: Connection,
        private walletPublicKey: PublicKey,
        private walletPrivateKeyKey: string
    ) {
        this.cache = new NodeCache({ stdTTL: 300 }); // Cache TTL set to 5 minutes
        const umi = createUmi(this.connection.rpcEndpoint);
        umi.use(mplTokenMetadata());
        const umiUser = umi.eddsa.createKeypairFromSecretKey(
            this.privateKeyUint8Array
        );
        umi.use(keypairIdentity(umiUser));
        this.umi = umi;
    }

    async getBalance() {
        let balance = await this.connection.getBalance(this.walletPublicKey);
        return {
            value: balance,
            formater: `${balance / LAMPORTS_PER_SOL} SOL`,
        };
    }

    get privateKeyUint8Array() {
        return bs58.decode(this.walletPrivateKeyKey);
    }

    async createCollection({
        name,
        symbol,
        adminPublicKey,
        uri,
        fee,
    }: {
        name: string;
        symbol: string;
        adminPublicKey: string;
        uri: string;
        fee: number;
    }): Promise<any> {
        const collectionMint = generateSigner(this.umi);
        elizaLogger.log("collectionMint", collectionMint, percentAmount(5));
        let transaction = new TransactionBuilder();
        const info = {
            name,
            symbol,
            uri,
        };
        console.log(`Metadata uploaded: ${uri}`);
        transaction = transaction.add(
            createNft(this.umi, {
                ...info,
                mint: collectionMint,
                sellerFeeBasisPoints: percentAmount(fee),
                isCollection: true,
            })
        );

        transaction = transaction.add(
            updateV1(this.umi, {
                mint: collectionMint.publicKey,
                newUpdateAuthority: publicKey(adminPublicKey), // updateAuthority's public key
            })
        );

        const res = await transaction.sendAndConfirm(this.umi, {
            confirm: {},
        });

        // await sleep(5000);
        // const createdCollectionNft = await fetchDigitalAsset(
        //     this.umi,
        //     collectionMint.publicKey
        // );
        const address = collectionMint.publicKey
        return {
            link: getExplorerLink("address", address, "devnet"),
            address
        };
    }

    async mintNFT({
        collectionAddress,
        adminPublicKey,
        name,
        uri,
        fee,
    }: {
        collectionAddress: string;
        adminPublicKey: string;
        name: string;
        uri: string;
        fee: number;
    }): Promise<any> {
        const umi = this.umi;
        const mint = generateSigner(umi);

        let transaction = new TransactionBuilder();
        console.log("collectionAddress", collectionAddress);
        const collectionAddressKey = publicKey(collectionAddress);
        // Add SOL transfer instruction (0.1 SOL)
        const receiverAddressKey = publicKey(adminPublicKey); // Replace with actual receiver address
        transaction = transaction.add(
            transferSol(umi, {
                source: umi.identity,
                destination: receiverAddressKey,
                amount: sol(0.1),
            })
        );
        const info = {
            name,
            uri,
        };
        transaction = transaction.add(
            createNft(umi, {
                mint,
                ...info,
                sellerFeeBasisPoints: percentAmount(fee),
                collection: {
                    key: collectionAddressKey,
                    verified: false,
                },
            })
        );

        transaction = transaction.add(
            updateV1(umi, {
                mint: mint.publicKey,
                newUpdateAuthority: publicKey(adminPublicKey), // updateAuthority's public key
            })
        );

        await transaction.sendAndConfirm(umi);
        //
        // await sleep();
        // const createdNft = await fetchDigitalAsset(umi, mint.publicKey);
        //
        // console.log(
        //     `🖼️ Created NFT! Address is ${getExplorerLink(
        //         "address",
        //         createdNft.mint.publicKey,
        //         "devnet"
        //     )}`
        // );
        const address = mint.publicKey
        return {
            link: getExplorerLink("address", address, "devnet"),
            address
        };
    }

    async verifyNft({
        collectionAddress,
        nftAddress,
    }: {
        collectionAddress: string;
        nftAddress: string;
    }) {
        const umi = this.umi;
        const collectionAddressKey = publicKey(collectionAddress);
        const nftAddressKey = publicKey(nftAddress);
        console.log("collectionAddress", collectionAddress);
        console.log("nftAddress", nftAddress);

        let transaction = new TransactionBuilder();
        transaction = transaction.add(
            verifyCollectionV1(umi, {
                metadata: findMetadataPda(umi, { mint: nftAddressKey }),
                collectionMint: collectionAddressKey,
                authority: umi.identity,
            })
        );

        await transaction.sendAndConfirm(umi);

        console.log(
            `✅ NFT ${nftAddress} verified as member of collection ${collectionAddress}! See Explorer at ${getExplorerLink(
                "address",
                nftAddress,
                "devnet"
            )}`
        );
    }
}

export default WalletSolana;
