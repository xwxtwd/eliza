import {
    IAgentRuntime,
    IAwsS3Service,
    Service,
    ServiceType,
} from "@ai16z/eliza";
import {
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from "fs";
import * as path from "path";

interface UploadResult {
    success: boolean;
    url?: string;
    error?: string;
}

interface JsonUploadResult extends UploadResult {
    key?: string;  // 添加存储的键值
}

export class AwsS3Service extends Service implements IAwsS3Service {
    static serviceType: ServiceType = ServiceType.AWS_S3;

    private s3Client: S3Client;
    private bucket: string;
    private fileUploadPath: string;
    getInstance(): IAwsS3Service {
        return AwsS3Service.getInstance();
    }
    private runtime: IAgentRuntime | null = null;

    async initialize(runtime: IAgentRuntime): Promise<void> {
        console.log("Initializing ImageDescriptionService");
        this.runtime = runtime;
        const AWS_ACCESS_KEY_ID = runtime.getSetting("AWS_ACCESS_KEY_ID");
        const AWS_SECRET_ACCESS_KEY = runtime.getSetting(
            "AWS_SECRET_ACCESS_KEY"
        );
        const AWS_REGION = runtime.getSetting("AWS_REGION");
        const AWS_S3_BUCKET = runtime.getSetting("AWS_S3_BUCKET");
        if (
            !AWS_ACCESS_KEY_ID ||
            !AWS_SECRET_ACCESS_KEY ||
            !AWS_REGION ||
            !AWS_S3_BUCKET
        ) {
            throw new Error(
                "Missing required AWS credentials in environment variables"
            );
        }

        this.s3Client = new S3Client({
            region: AWS_REGION,
            credentials: {
                accessKeyId: AWS_ACCESS_KEY_ID,
                secretAccessKey: AWS_SECRET_ACCESS_KEY,
            },
        });
        this.fileUploadPath = runtime.getSetting("AWS_S3_UPLOAD_PATH") ?? "";
        this.bucket = AWS_S3_BUCKET;
    }

    async uploadFile(
        filePath: string,
        useSignedUrl: boolean = false,
        expiresIn: number = 900
    ): Promise<UploadResult> {
        try {
            if (!fs.existsSync(filePath)) {
                return {
                    success: false,
                    error: "File does not exist",
                };
            }

            const fileContent = fs.readFileSync(filePath);

            const baseFileName = `${Date.now()}-${path.basename(filePath)}`;
            // 根据是否公开访问决定存储路径
            const fileName =`${this.fileUploadPath}/${baseFileName}`.replaceAll('//', '/');
            // 设置上传参数
            const uploadParams = {
                Bucket: this.bucket,
                Key: fileName,
                Body: fileContent,
                ContentType: this.getContentType(filePath),
            };

            // 上传文件
            await this.s3Client.send(new PutObjectCommand(uploadParams));

            // 构建结果对象
            const result: UploadResult = {
                success: true,
            };

            // 如果不使用签名URL，返回公开访问URL
            if (!useSignedUrl) {
                result.url = `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
            } else {
                const getObjectCommand = new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: fileName,
                });
                result.url = await getSignedUrl(
                    this.s3Client,
                    getObjectCommand,
                    {
                        expiresIn, // 15分钟，单位为秒
                    }
                );
            }

            return result;
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Unknown error occurred",
            };
        }
    }

    /**
     * 为已存在的文件生成签名URL
     */
    async generateSignedUrl(
        fileName: string,
        expiresIn: number = 900
    ): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: fileName,
        });

        return await getSignedUrl(this.s3Client, command, { expiresIn });
    }

    private getContentType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes: { [key: string]: string } = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        };
        return contentTypes[ext] || "application/octet-stream";
    }

    /**
     * 上传 JSON 对象到 S3
     * @param jsonData 要上传的 JSON 数据
     * @param fileName 文件名（可选，不包含路径）
     * @param subDirectory 子目录（可选）
     * @param useSignedUrl 是否使用签名URL
     * @param expiresIn 签名URL过期时间（秒）
     */
    async uploadJson(
        jsonData: any,
        fileName?: string,
        subDirectory?: string,
        useSignedUrl: boolean = false,
        expiresIn: number = 900
    ): Promise<JsonUploadResult> {
        try {
            // 验证输入
            if (!jsonData) {
                return {
                    success: false,
                    error: "JSON data is required",
                };
            }

            // 生成文件名（如果没有提供）
            const timestamp = Date.now();
            const actualFileName = fileName || `${timestamp}.json`;

            // 构建完整的文件路径
            let fullPath = this.fileUploadPath || '';
            if (subDirectory) {
                fullPath = `${fullPath}/${subDirectory}`.replace(/\/+/g, '/');
            }
            const key = `${fullPath}/${actualFileName}`.replace(/\/+/g, '/');

            // 将 JSON 转换为字符串
            const jsonString = JSON.stringify(jsonData, null, 2);

            // 设置上传参数
            const uploadParams = {
                Bucket: this.bucket,
                Key: key,
                Body: jsonString,
                ContentType: 'application/json',
            };

            // 上传文件
            await this.s3Client.send(new PutObjectCommand(uploadParams));

            // 构建结果
            const result: JsonUploadResult = {
                success: true,
                key: key,
            };

            // 根据需求返回对应的 URL
            if (!useSignedUrl) {
                result.url = `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
            } else {
                const getObjectCommand = new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                });
                result.url = await getSignedUrl(
                    this.s3Client,
                    getObjectCommand,
                    { expiresIn }
                );
            }

            return result;

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error occurred",
            };
        }
    }
}

export default AwsS3Service;
