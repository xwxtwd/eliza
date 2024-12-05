import {
    Action,
    composeContext,
    elizaLogger,
    generateImage,
    generateText,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    Plugin,
    ServiceType,
    State,
} from "@ai16z/eliza";
import { AwsS3Service } from "@ai16z/plugin-node";
import { imageGeneration } from "@ai16z/plugin-image-generation";

import fs from "fs";
import path from "path";
import WalletSolana from "./provider/wallet/walletSolana.ts";
import { Connection, clusterApiUrl, PublicKey } from "@solana/web3.js";

const nftTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}
# Task: Generate an image to Prompt the  {{agentName}}'s appearance, with the total character count MUST be less than 280.
`;

export function saveBase64Image(base64Data: string, filename: string): string {
    // Create generatedImages directory if it doesn't exist
    const imageDir = path.join(process.cwd(), "generatedImages");
    if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
    }

    // Remove the data:image/png;base64 prefix if it exists
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, "");

    // Create a buffer from the base64 string
    const imageBuffer = Buffer.from(base64Image, "base64");

    // Create full file path
    const filepath = path.join(imageDir, `${filename}.png`);

    // Save the file
    fs.writeFileSync(filepath, imageBuffer);

    return filepath;
}

export async function saveHeuristImage(
    imageUrl: string,
    filename: string
): Promise<string> {
    const imageDir = path.join(process.cwd(), "generatedImages");
    if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
    }

    // Fetch image from URL
    const response = await fetch(imageUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    // Create full file path
    const filepath = path.join(imageDir, `${filename}.png`);

    // Save the file
    fs.writeFileSync(filepath, imageBuffer);

    return filepath;
}

const nftCollectionGeneration: Action = {
    name: "GENERATE_COLLECTION",
    similes: [
        "COLLECTION_GENERATION",
        "COLLECTION_GEN",
        "CREATE_COLLECTION",
        "MAKE_COLLECTION",
        "GENERATE_COLLECTION",
    ],
    description: "Generate an NFT collection for the message",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const AwsAccessKeyIdOk = !!runtime.getSetting("AWS_ACCESS_KEY_ID");
        const AwsSecretAccessKeyOk = !!runtime.getSetting(
            "AWS_SECRET_ACCESS_KEY"
        );
        const AwsRegionOk = !!runtime.getSetting("AWS_REGION");
        const AwsS3BucketOk = !!runtime.getSetting("AWS_S3_BUCKET");

        return (
            AwsAccessKeyIdOk ||
            AwsSecretAccessKeyOk ||
            AwsRegionOk ||
            AwsS3BucketOk
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: { [key: string]: unknown },
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Composing state for message:", message);
        state = (await runtime.composeState(message)) as State;
        const userId = runtime.agentId;
        elizaLogger.log("User ID:", userId);

        const awsS3Service: AwsS3Service = runtime.getService(
            ServiceType.AWS_S3
        );

        const context = composeContext({
            state,
            template: nftTemplate,
        });

        const images = await generateImage(
            {
                prompt: `Generate a logo with the text "${runtime.character.name}", using orange as the main color, with a sci-fi and mysterious background theme`,
                width: 300,
                height: 300,
            },
            runtime
        );

        if (images.success && images.data && images.data.length > 0) {
            elizaLogger.log(
                "Collection image generation successful, number of images:",
                images.data.length
            );
            for (let i = 0; i < images.data.length; i++) {
                const image = images.data[i];

                // Save the image and get filepath
                const filename = `generated_${Date.now()}_${i}`;
                if (image.startsWith("http")) {
                    elizaLogger.log("Generating image url:", image);
                }
                // Choose save function based on image data format
                const filepath = image.startsWith("http")
                    ? await saveHeuristImage(image, filename)
                    : saveBase64Image(image, filename);

                elizaLogger.log("collection logo filepath", filepath);

                const logoPath = await awsS3Service.uploadFile(filepath, false);
                const publicKey = process.env.SOLANA_PUBLIC_KEY;
                const privateKey = process.env.SOLANA_PRIVATE_KEY;
                const adminPublicKey = process.env.SOLANA_ADMIN_PUBLIC_KEY;
                const adminPrivateKey = process.env.SOLANA_ADMIN_PRIVATE_KEY;
                const collectionInfo = {
                    name: `${runtime.character.name}`,
                    symbol: `${runtime.character.name.toUpperCase()}`,
                    adminPublicKey,
                    fee: 0,
                    uri: "",
                };
                const jsonFilePath = await awsS3Service.uploadJson({
                    name: collectionInfo.name,
                    description: `${collectionInfo.name}`,
                    image: logoPath.url,
                });
                collectionInfo.uri = jsonFilePath.url;
                const connection = new Connection(clusterApiUrl("devnet"));

                const wallet = new WalletSolana(
                    connection,
                    new PublicKey(publicKey),
                    privateKey
                );

                const collectionAddress = await wallet.createCollection({
                    ...collectionInfo,
                });

                elizaLogger.log("Collection ID:", collectionAddress);

                elizaLogger.log("NFT Prompt context:", context);
                let nftPrompt = await generateText({
                    runtime,
                    context,
                    modelClass: ModelClass.SMALL,
                });
                nftPrompt += runtime.character?.nft?.prompt || "";
                nftPrompt += "The image should only feature one person";
                elizaLogger.log("NFT Prompt:", nftPrompt);
                const imageGenerationAction = imageGeneration;
                imageGenerationAction.handler(
                    runtime,
                    {
                        userId: message.userId,
                        agentId: message.userId,
                        roomId: message.roomId,
                        content: {
                            text: nftPrompt,
                        },
                    },
                    state,
                    options,
                    async (newMessage, files) => {
                        if (files?.length > 0) {
                            for (let i = 0; i < files.length; i++) {
                                const file = files[i];
                                const res = await awsS3Service.uploadFile(
                                    file.attachment,
                                    false
                                );
                                const nftIndex = 10;
                                const nftInfo = {
                                    name: `${collectionInfo.name} #${nftIndex}`,
                                    description: `${collectionInfo.name} #${nftIndex}`,
                                };
                                const jsonFilePath =
                                    await awsS3Service.uploadJson({
                                        ...nftInfo,
                                        image: res.url,
                                    });
                                elizaLogger.log("Image S3 url:", res);
                                const nftAddress = await wallet.mintNFT({
                                    name: nftInfo.name,
                                    uri: jsonFilePath.url,
                                    collectionAddress,
                                    adminPublicKey:
                                        collectionInfo.adminPublicKey,
                                    fee: collectionInfo.fee,
                                });
                                elizaLogger.log("NFT ID:", nftAddress);

                                const adminWallet = new WalletSolana(
                                    connection,
                                    new PublicKey(adminPublicKey),
                                    adminPrivateKey
                                );
                                adminWallet.verifyNft({
                                    collectionAddress,
                                    nftAddress,
                                });
                            }
                        }
                        return [];
                    }
                );
            }
        } else {
            elizaLogger.error(
                "Collection image generation failed or returned no data."
            );
        }

        // callback();
    },
    examples: [
        // TODO: We want to generate images in more abstract ways, not just when asked to generate an image

        [
            {
                user: "{{user1}}",
                content: { text: "Generate a collection" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's the collection you requested.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Generate a collection using {{agentName}}" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "We've successfully created a collection.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Create a collection using {{agentName}}" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's the collection you requested.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Build a Collection" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The collection has been successfully built.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Assemble a collection with {{agentName}}" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The collection has been assembled",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Make a collection" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The collection has been produced successfully.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Compile a collection" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The collection has been compiled.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
    ],
} as Action;

export const nftCollectionGenerationPlugin: Plugin = {
    name: "nftCollectionGeneration",
    description: "Generate NFT Collections",
    actions: [nftCollectionGeneration],
    evaluators: [],
    providers: [],
};
